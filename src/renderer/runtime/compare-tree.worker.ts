import { prepareVisibleTreeProjection, type CompareTreeRequest } from './compare-tree-protocol'

self.onmessage = (event: MessageEvent<CompareTreeRequest>) => {
  const result = prepareVisibleTreeProjection(event.data)
  self.postMessage(result, { transfer: [result.indexes.buffer, result.states.buffer, result.paths.buffer] })
}
