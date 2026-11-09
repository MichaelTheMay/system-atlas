import { describe, expect, it } from 'vitest';
import {
  boardTemplate,
  BoardDocument,
  BoardSpec,
  emptyBoardDocument,
  type Scenario,
} from '@atlas/schema';
import { missingHops, scenarioGaps } from '../src/index.ts';

/** A board document from a template spec (what the daemon stores for a new template board). */
function templateDoc(id: string): BoardDocument {
  const spec = BoardSpec.parse(boardTemplate(id)!.spec);
  const doc = emptyBoardDocument();
  for (const c of spec.components) doc.components[c.id] = { ...c, elementIds: [] };
  for (const k of spec.connections) doc.connections[k.id] = { ...k };
  doc.scenarios = spec.scenarios.map((s) => ({ ...s }));
  return BoardDocument.parse(doc);
}

const scenario = (steps: Scenario['steps']): Scenario => ({
  id: 'sc',
  name: 'Test',
  steps,
  origin: { author: 'user' },
  status: 'active',
});
const hop = (id: string, connectionId: string) => ({ id, connectionId, text: '' });
const at = (id: string, componentId: string) => ({ id, componentId, text: '' });

describe('scenario continuity (D04)', () => {
  // chat template: user -k1-> mobile -k3-> lb -k5-> gw -k8-> chat -k9-> store, chat -k10-> bus
  const doc = templateDoc('chat');

  it('flags a step that starts somewhere the flow has not reached', () => {
    // mobile -> lb, then gw -> chat: nothing took the flow from the load balancer to the gateway
    const s = scenario([hop('a', 'k3'), hop('b', 'k8'), hop('c', 'k9')]);
    expect([...scenarioGaps(doc, s)]).toEqual(['b']);
  });

  it('allows a flow to fan out and return: a step may start at any reached component', () => {
    // chat -> store, then chat -> bus: the second hop starts at chat again, not at the store
    const s = scenario([hop('a', 'k8'), hop('b', 'k9'), hop('c', 'k10'), at('d', 'gw')]);
    expect(scenarioGaps(doc, s).size).toBe(0);
  });

  it('flags a component step on an unreached component, and ignores unbound steps', () => {
    const s = scenario([
      hop('a', 'k1'),
      { id: 'note', text: 'no hop, no component' },
      at('b', 'store'),
      hop('c', 'k9'),
    ]);
    // the store was never reached; the chat -> store hop then touches it, so it is connected
    expect([...scenarioGaps(doc, s)]).toEqual(['b']);
  });

  it('finds the template scenario gap and the hop that closes it', () => {
    const s1 = doc.scenarios.find((s) => s.id === 's1')!;
    const gaps = [...scenarioGaps(doc, s1)];
    expect(gaps).toHaveLength(1);
    const fix = missingHops(doc, s1, gaps[0]!);
    expect(fix).toEqual(['k5']);
    // inserting it before the gap step leaves no gap
    const i = s1.steps.findIndex((x) => x.id === gaps[0]);
    const fixed = scenario([
      ...s1.steps.slice(0, i),
      ...fix.map((k, n) => hop(`fix-${n}`, k)),
      ...s1.steps.slice(i),
    ]);
    expect(scenarioGaps(doc, fixed).size).toBe(0);
  });

  it('chains several hops, shortest first, and is stable', () => {
    // user -> mobile, then push -> apns: mobile -k3- lb -k5- gw -k8- chat -k10- bus -k11- push
    const s = scenario([hop('a', 'k1'), hop('b', 'k12')]);
    expect(missingHops(doc, s, 'b')).toEqual(['k3', 'k5', 'k8', 'k10', 'k11']);
    expect(missingHops(doc, s, 'b')).toEqual(missingHops(doc, s, 'b'));
  });

  it('returns nothing for a connected step or an unreachable one', () => {
    const s = scenario([hop('a', 'k1'), hop('b', 'k3')]);
    expect(missingHops(doc, s, 'b')).toEqual([]);
    const island = BoardDocument.parse({
      ...doc,
      components: {
        ...doc.components,
        lonely: { ...doc.components.gw!, id: 'lonely', label: 'Lonely', elementIds: [] },
      },
    });
    const t = scenario([hop('a', 'k1'), at('b', 'lonely')]);
    expect([...scenarioGaps(island, t)]).toEqual(['b']);
    expect(missingHops(island, t, 'b')).toEqual([]);
  });
});
