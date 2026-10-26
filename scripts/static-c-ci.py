#!/usr/bin/env python3
"""GitHub-only source selection, static packaging and scoped C publication."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile
import tempfile
import urllib.request

SITES = {
    'code-line': {'repository': 'react-laravel/code-line-analysis', 'branch': 'electron',
                  'baseline': 'cb40424b76505f2f4e478d43c959ec21a2df3d26', 'artifact': 'dist/renderer'},
    'simple-diff': {'repository': 'react-laravel/simple-diff', 'branch': 'electron',
                    'baseline': '096638e870ad1baad1df01af18f6d314fdc1b996', 'artifact': 'dist/renderer'},
    'mind': {'repository': 'react-laravel/knowledge-graph-viewer', 'branch': 'main',
             'baseline': '22fbd78f385c8926ae66be1712f6385cc4ddb97a', 'artifact': 'dist'},
    'ip-checker': {'repository': 'react-laravel/ip-checker', 'branch': 'main',
                   'baseline': '24c426455a191b6516786710a646f59966ebf75e', 'artifact': '.'},
}
IP_FILES = {'index.html', 'styles.css', 'app.js', 'browser-utils.js', 'core.js',
            'detectors.js', 'ui-components.js', 'ui.js'}
SUFFIXES = {'.html', '.htm', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg',
            '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff',
            '.woff2', '.ttf', '.otf', '.txt', '.wasm'}
FORBIDDEN = {'.env', '.npmrc', 'auth.json', 'package.json', 'package-lock.json',
             'composer.json', 'composer.lock', 'id_rsa', 'id_ed25519'}
SHA = re.compile(r'[0-9a-f]{40}\Z')


def package_revision(site, workflow, source, files):
    if site not in SITES or not SHA.fullmatch(workflow) or not SHA.fullmatch(source):
        raise ValueError('Full workflow/source revisions are required')
    canonical = json.dumps(files, sort_keys=True, separators=(',', ':')).encode()
    identity = ('static-c-v1\0' + site + '\0' + workflow + '\0' + source).encode() + b'\0' + canonical
    return hashlib.sha256(identity).hexdigest()[:40]


def static_path(name):
    path = PurePosixPath(name)
    if not name or path.is_absolute() or '..' in path.parts or not re.fullmatch(r'[A-Za-z0-9_./@+-]+', name):
        raise ValueError('Unsafe static output path')
    if any(part.startswith('.') or part.lower() in FORBIDDEN for part in path.parts) or Path(name).suffix.lower() not in SUFFIXES:
        raise ValueError('Non-runtime/static file cannot enter the package')
    return path


def assert_source(site, root):
    if site in ('code-line', 'simple-diff'):
        data = json.loads((root / 'package.json').read_text())
        if (root / 'src-tauri').exists() or not (root / 'src/main').is_dir() or 'build:web' not in data.get('scripts', {}):
            raise ValueError('The static website must use the verified Electron web edition, not Tauri main')
    elif site == 'mind':
        if json.loads((root / 'package.json').read_text()).get('name') != 'knowledge-graph-viewer':
            raise ValueError('Wrong knowledge graph application source')
    else:
        if not all((root / path).is_file() and not (root / path).is_symlink() for path in IP_FILES):
            raise ValueError('Missing original native browser application files')


def select(site, environment=os.environ, get=None):
    settings = SITES[site]
    if environment.get('GITHUB_REPOSITORY') != settings['repository']:
        raise ValueError('This workflow belongs to a different repository')
    if environment.get('GITHUB_EVENT_NAME') == 'push':
        if environment.get('GITHUB_REF_NAME') != settings['branch']:
            raise ValueError('Only the website source branch can auto-publish')
        revision = environment.get('GITHUB_SHA', '')
    elif environment.get('GITHUB_EVENT_NAME') == 'workflow_dispatch':
        revision = environment.get('REQUESTED_SOURCE_REVISION') or settings['baseline']
    else:
        raise ValueError('Unsupported publication event')
    if not SHA.fullmatch(revision):
        raise ValueError('Select an immutable full source commit')
    endpoint = 'https://api.github.com/repos/' + settings['repository'] + '/compare/' + revision + '...' + settings['branch']
    if get is None:
        token = environment.get('GH_TOKEN')
        if not token:
            raise ValueError('The read-only built-in GitHub token is required for source verification')
        request = urllib.request.Request(endpoint, headers={'Authorization': 'Bearer ' + token,
                                         'Accept': 'application/vnd.github+json', 'User-Agent': 'static-c-source-check'})
        with urllib.request.urlopen(request, timeout=45) as response:
            content = response.read(8 * 1024 * 1024 + 1)
        if len(content) > 8 * 1024 * 1024:
            raise ValueError('Source comparison metadata is unexpectedly large')
        comparison = json.loads(content)
    else:
        comparison = get(endpoint)
    if comparison.get('status') not in ('identical', 'ahead') or comparison.get('base_commit', {}).get('sha') != revision:
        raise ValueError('Selected source is not on the verified website branch')
    if environment.get('GITHUB_EVENT_NAME') == 'push' and comparison.get('status') != 'identical':
        raise ValueError('A newer website commit exists; this stale push must not publish')
    return revision


def package(site, source, output, revision, source_revision):
    if not SHA.fullmatch(revision) or not SHA.fullmatch(source_revision):
        raise ValueError('Full workflow and source revisions are required')
    source = Path(source).resolve()
    assert_source(site, source)
    root = (source / SITES[site]['artifact']).resolve()
    if root != source and not root.is_relative_to(source):
        raise ValueError('Build output escapes source workspace')
    entries = []
    files = {}
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        if site == 'ip-checker' and relative not in IP_FILES:
            continue
        if path.is_symlink():
            raise ValueError('No runtime symlinks may enter a static package')
        if not path.is_file():
            continue
        if path.suffix == '.map':
            continue
        static_path(relative)
        if relative == 'DEPLOYMENT.json' or path.stat().st_nlink != 1:
            raise ValueError('Unexpected build metadata or hardlink')
        raw = path.read_bytes()
        if len(raw) > 32 * 1024 * 1024:
            raise ValueError('Static file exceeds the single-file budget')
        files[relative] = {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()}
        entries.append((relative, raw))
    if 'index.html' not in files or len(files) > 4096 or sum(item['bytes'] for item in files.values()) > 128 * 1024 * 1024:
        raise ValueError('Static package has invalid runtime contents/budget')
    workflow_revision = revision
    revision = package_revision(site, workflow_revision, source_revision, files)
    manifest = {'site': site, 'repository': SITES[site]['repository'], 'revision': revision, 'workflow_revision': workflow_revision,
                'source_revision': source_revision, 'files': files}
    entries.append(('DEPLOYMENT.json', (json.dumps(manifest, sort_keys=True, separators=(',', ':')) + '\n').encode()))
    with Path(output).open('xb') as destination:
        with gzip.GzipFile(fileobj=destination, mode='wb', compresslevel=6, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|') as archive:
                for name, raw in entries:
                    info = tarfile.TarInfo(name)
                    info.size, info.mode, info.uid, info.gid, info.mtime = len(raw), 0o644, 0, 0, 0
                    info.uname = info.gname = 'root'
                    archive.addfile(info, io.BytesIO(raw))
    if Path(output).stat().st_size > 48 * 1024 * 1024:
        Path(output).unlink()
        raise ValueError('Compressed static package exceeds its budget')
    return {'site': site, 'revision': revision, 'workflow_revision': workflow_revision, 'files': len(files), 'runtime_bytes': sum(item['bytes'] for item in files.values()),
            'archive_bytes': Path(output).stat().st_size, 'source_revision': source_revision,
            'environment_credentials_tests_and_source_maps_excluded': True}


def deploy(site, archive, revision, check_only=False, environment=os.environ):
    if not SHA.fullmatch(revision):
        raise ValueError('Expected a full workflow revision')
    key = environment.get('C_STATIC_DEPLOY_SSH_KEY')
    known = environment.get('C_STATIC_DEPLOY_KNOWN_HOSTS')
    if not key or not known:
        raise ValueError('Configure this repository single-site C deployment Secrets')
    with tempfile.TemporaryDirectory(prefix='static-c-auth-', dir=environment.get('RUNNER_TEMP')) as directory:
        directory = Path(directory)
        for name, text in [('key', key), ('known_hosts', known)]:
            path = directory / name
            path.write_text(text.rstrip('\n') + '\n')
            path.chmod(0o600)
        config = directory / 'config'
        config.write_text('Host static-c\n  HostName 120.26.21.64\n  User static-c-' + site +
                          '\n  IdentityFile ' + str(directory / 'key') + '\n  UserKnownHostsFile ' + str(directory / 'known_hosts') +
                          '\n  IdentitiesOnly yes\n  BatchMode yes\n  StrictHostKeyChecking yes\n  ConnectTimeout 15\n  ServerAliveInterval 15\n  ServerAliveCountMax 3\n')
        config.chmod(0o600)

        def ssh(command, stream=None):
            result = subprocess.run(['ssh', '-F', str(config), 'static-c', command], stdin=stream,
                                    capture_output=True, timeout=180)
            if result.returncode:
                raise ValueError('Scoped C connection or publication rejected')
            data = json.loads(result.stdout)
            if data.get('site') != site:
                raise ValueError('Unexpected C site response')
            return data
        if check_only:
            result = ssh('check')
            if result.get('check_ok') is not True:
                raise ValueError('C site health check failed')
        else:
            with Path(archive).open('rb') as stream:
                uploaded = ssh('receive ' + revision, stream)
            if uploaded.get('received') is not True or uploaded.get('revision') != revision:
                raise ValueError('C did not accept the expected static upload')
            result = ssh('publish ' + revision)
            if result.get('revision') != revision or not (result.get('published') or result.get('already_active')):
                raise ValueError('C did not publish the expected static revision')
        return {'site': site, 'check_only': check_only, 'C_result': result, 'temporary_private_key_deleted_on_exit': True}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['select', 'assert-source', 'package', 'deploy'])
    parser.add_argument('--site', choices=SITES, required=True)
    parser.add_argument('--source', default='source')
    parser.add_argument('--output')
    parser.add_argument('--revision', default=os.environ.get('GITHUB_SHA', ''))
    parser.add_argument('--source-revision')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    if args.operation == 'select':
        selected = select(args.site)
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
            output.write('source_revision=' + selected + '\n')
        result = {'source_revision': selected, 'website_branch_verified': True}
    elif args.operation == 'assert-source':
        assert_source(args.site, Path(args.source))
        result = {'correct_website_edition': True}
    elif args.operation == 'package':
        result = package(args.site, args.source, args.output, args.revision, args.source_revision)
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                output.write('package_revision=' + result['revision'] + '\n')
    else:
        result = deploy(args.site, args.output, args.revision, args.check_only)
    print(json.dumps(result, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print(json.dumps({'static_C_CI_ok': False, 'no_private_values_in_output': True}))
        raise SystemExit(1)
