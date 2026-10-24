import { settleBodyLayout } from './for-each-body-layout';
import {
  mapLevel,
  type GraphLevel,
  type LevelChange,
  type ScopePath,
} from './scopes';

/** Changes one level; a body is first stored in the layout it's shown in. */
export function changeLevel<Graph extends GraphLevel>(
  graph: Graph,
  scope: ScopePath,
  change: LevelChange,
): Graph {
  return mapLevel(graph, scope, change, settleBodyLayout);
}
