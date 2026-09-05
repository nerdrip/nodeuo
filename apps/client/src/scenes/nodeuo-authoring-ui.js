import { NodeUOSpellComposerMessage, NodeUOSpecializationMessage } from '@uo/nodeuo-protocol';

const lazySpellComposer = () => import('../ui/gumps/spell-composer-gump.js')
  .then((module) => module.SpellComposerGump);
const lazySpecializations = () => import('../ui/gumps/specialization-gump.js')
  .then((module) => module.SpecializationGump);

/** Register negotiated NodeUO-only authoring windows on a game scene. */
export function registerNodeUOAuthoringUi(scene) {
  scene._sub('nodeuo:spell-composer', ({ kind, requestId, payload }) => {
    if (kind !== NodeUOSpellComposerMessage.Open) return;
    scene._toggleGump('spell-composer', async () => {
      const SpellComposerGump = await lazySpellComposer();
      return new SpellComposerGump({ requestId, payload });
    });
  });
  scene._sub('nodeuo:specializations', ({ kind, requestId, payload }) => {
    if (kind !== NodeUOSpecializationMessage.Open) return;
    scene._toggleGump('specializations', async () => {
      const SpecializationGump = await lazySpecializations();
      return new SpecializationGump({ requestId, payload });
    });
  });
}
