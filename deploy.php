<?php
// This static website now publishes through GitHub hosted CI and a single-site
// unprivileged C account. Never revive localhost deployment on retired A.
fwrite(STDERR, "Use .github/workflows/deploy-static-c.yml for this static website.\n");
exit(1);
