// Item-script registry — loads every script under `items/scripts/**/*.js`
// (excluding `_shared`) and registers it with the runtime.
//
// Adding a new script:
//   1. Create a file at items/scripts/<category>/<slug>.js exporting
//      a `default function (api) { return { name, onXxx, ... } }`.
//   2. Add it to the import list below. Auto-discovery via Vite/glob
//      isn't available in the Node.js script runtime, so the list is
//      explicit — this also acts as a discoverable manifest.
//   3. Reference the script name in items.json: `"script": "<name>"`.
//
// Categories are organisational only (lights/, consumables/, tools/,
// traps/) — there's no semantic difference between them at runtime.

import buildTorch         from './lights/torch.js';
import buildLantern       from './lights/lantern.js';
import buildPotionHeal    from './consumables/potion-heal.js';
import buildPotionCure    from './consumables/potion-cure.js';
import buildPotionRefresh from './consumables/potion-refresh.js';
import {
  buildPoisonPotion, buildEodonPotion, buildEndlessDecanter, buildAreaPotion,
} from './consumables/special-potions.js';
import buildFood          from './consumables/food.js';
import buildDrink         from './consumables/drink.js';
import buildGreenThorns, { buildGreenThornsSolenHole } from './consumables/green-thorns.js';
import { buildGenderChangeToken, buildRaceChangeToken } from './consumables/promotional-tokens.js';
import buildBankCheck     from './consumables/bank-check.js';
import buildImbueRecipeScroll from './consumables/imbue-recipe-scroll.js';
import buildEventLogScroll from './consumables/event-log-scroll.js';
import buildPowerHourScroll from './consumables/power-hour-scroll.js';
import buildBandage       from './tools/bandage.js';
import buildMagicScroll   from './tools/magic-scroll.js';
import buildSpikeTrap     from './traps/spike-trap.js';
import buildPressurePlate from './traps/pressure-plate.js';
import { buildGasTrap, buildFireColumnTrap, buildSawTrap, buildDartTrap } from './traps/trap-extras.js';
import buildTeleporter    from './world/teleporter.js';
import buildPeerlessAltar from './world/peerless-altar.js';
import buildPublicMoongate, { registerMoongateCommand } from './world/public-moongate.js';
import buildSignPost from './world/sign-post.js';
import {
  buildBilgePump, buildShipAnchor, buildShipWheel, buildCabinDoor,
  buildSeaChart, buildShipMapTable, buildDock, buildDockCrane,
  buildMooringPost, buildShipPlans, buildCannon, buildLobsterTrap, buildCrabTrap,
} from './world/nautical-items.js';
import { buildVirtueAltar, buildPeerlessChaosAltar, buildHealingAltar, buildResurrectionAltar } from './world/altars.js';
import { buildFarmablePlant } from './world/farmable.js';
import { buildPotPlantScript } from '../behaviors/pot-plants.js';
import buildReagentBag    from './tools/reagent-bag.js';
import buildMagicWand     from './tools/magic-wand.js';
import buildRunebook, { registerBookCommand } from './tools/runebook.js';
import buildReadableBook  from './tools/readable-book.js';
import buildRepairDeed   from './tools/repair-deed.js';
import buildHouseTransferDeed from './tools/house-transfer-deed.js';
import buildHouseTeleporter from './housing/house-teleporter.js';
import buildAddonDeed from './housing/addon-deed.js';
import {
  buildKeyScript, buildSkeletonKeyScript, buildKeyRingScript,
} from './tools/keys.js';
import buildCommodityDeed from './tools/commodity-deed.js';
import buildDyeTub from './tools/dye-tub.js';
import buildDisguiseKit from './tools/disguise-kit.js';
import buildStaffOrb from './tools/staff-orb.js';
import buildFirstAidBelt from './tools/first-aid-belt.js';
import buildBola from './tools/bola.js';
import buildAquarium, { buildFishBowl, buildAquariumFishingNet } from './functional/aquarium.js';
import buildRecallRune from './tools/recall-rune.js';
import {
  buildMessageInBottle, buildSosScript, buildSeaTreasureMapScript,
} from './tools/sos.js';
import {
  buildSpyglassScript, buildBedrollScript, buildBagOfSendingScript,
} from './tools/misc-tools.js';
import {
  buildNameChangeDeed, buildHairRestylingDeed, buildBeardRestylingDeed,
  buildIncenseScript, buildPerfumeScript, buildNecroReagentPouch,
} from './tools/cosmetic-deeds.js';
import {
  buildItemBlessDeed, buildClothingBlessDeed, buildBlessScroll,
} from './tools/bless-deeds.js';
import {
  buildFishingPoleScript, buildPickaxeScript, buildShovelScript,
  buildHatchetScript, buildSextantScript, buildInstrumentScript,
  buildSoulstoneScript,
} from './tools/skill-tools.js';
import buildTreasureChest from './world/treasure-chest.js';
import {
  buildAnvil, buildForge, buildLoom, buildSpinningWheel, buildOven,
  buildTinkerTools, buildCarpentryTools, buildInscriptionTools, buildAlchemyTable,
  buildFletchingStation, buildSewingMachine, buildSmithingPress,
  buildSpinningLathe, buildWritingDesk,
  buildTrainingDummy, buildCampfire, buildAnkh, buildAnkhOfSacrifice, buildBookshelf,
} from './functional/anvil-forge.js';
import {
  buildArcheryButte, buildBanner, buildFireplace, buildAwesomeDisturbingPortrait, buildBedOfNails,
  buildFlamingHead, buildFlamingHeadDeed, buildPickpocketDip,
  buildEasel, buildMusicBox, buildEnchantedGraniteCart, buildBlessedStatue, buildJewelryStand,
  buildAbattoirBlock, buildArcaneCircle, buildScarecrow, buildClawFootTub,
  buildMiningCart, buildSheepStatue, buildHarpsichord, buildHarpsichordRoll,
  buildRoseRug, buildSkullRug, buildFirePainting, buildShipPainting,
  buildFlourMill, buildWoodStove, buildHauntedMirror, buildTreeStump,
  buildHagStew, buildSolenAntHole, buildFountainAddon, buildFountainOfLife, buildDolphinRug,
} from './functional/decorative-addons.js';
import buildTrashBarrel from './functional/trash-barrel.js';
import buildSalvageBag from './functional/salvage-bag.js';
import buildFillableContainer from './functional/fillable-container.js';
import buildCommunicationCrystal from './functional/communication-crystals.js';
import buildVendorRentalContract from './functional/vendor-rental-contract.js';
import buildMoonstone, { buildMoonstoneGate } from './functional/moonstone.js';
import buildImprisonedMobile from './functional/imprisoned-mobile.js';
import buildCleanupAddonContainer from './functional/cleanup-addon-container.js';
import {
  buildMahjongSet, buildDiceRoll, buildDiceCup, buildCardsGame, buildBoardGame,
} from './functional/board-games.js';
import { buildBallotBox, buildPlayerBulletinBoard } from './functional/player-boards.js';
import buildSigilScript from './functional/sigil.js';
import buildSoulforge   from './functional/soulforge.js';
import buildHeartwoodRewardBag from './functional/heartwood-reward-bag.js';
import {
  buildSpellSchemaCodexScript, buildCustomSpellScrollScript, buildSpellcraftKnowledgeScript,
} from './functional/spell-schema.js';
import buildBraceletBinding from './equipment/bracelet-binding.js';
import buildInteriorDecorator from './functional/interior-decorator.js';
import buildMannequinDeed from './functional/mannequin.js';
import {
  buildMovingCrate, buildHouseRaffleStone, buildChestOfSending, buildBallOfSummoning,
} from './functional/house-extras.js';
import {
  buildRerollArtifact, buildMultiTool,
} from './tools/artifact-tools.js';
import {
  buildTreasureTrinket, buildRopeOfAscension,
} from './tools/utility-tools.js';
import buildPetBondingDeed from './tools/bonding-deed.js';
import buildRefreshStone from './world/refresh-stone.js';
import {
  buildHeritageTokenBag, buildTokunoPigmentSack, buildSanctuaryRewardBag,
} from './functional/quest-reward-bags.js';
import {
  buildSwitch, buildSecretDoor, buildSlidingDoor, buildPortcullis,
  buildDespiseAnkh, buildSpiderWeb, buildAcidVine, buildWorldTrap,
  buildXmlTileTrap, buildChickenCoop, buildHitchingPost, buildIncubator, buildIncubatorEgg,
} from './world/simple-items.js';
import {
  buildPuzzleChest, buildRaisableItem, buildRaiseSwitch, buildDoomLever,
} from './world/mechanism-items.js';
import {
  buildCaddelliteInfuser,
  buildGiftBoxNeon,
  buildIcyPatch,
  buildKhaldunTastyTreat,
  buildKronusScroll,
  buildMaabusCoffin,
  buildObsidianStatue,
  buildPetWhistle,
  buildPowderOfFortifying,
  buildSecretSwitch,
  buildSecretWall,
  buildSecretChest,
  buildServUOEthereal,
  buildServUOFreeTimer,
  buildServUOP1Marker,
  buildShimmeringCrystals,
  buildSpikedEggNog,
  buildTormentedChains,
  registerServUOP1Commands,
} from './functional/servuo-p1-items.js';

// Spell-field walk-on dispatcher (fire-field / poison-field / etc).
// Each field item carries an `_fieldOnWalkOn` closure stamped at
// spawn time; this script just routes the engine's `onWalkOn` event
// to that closure. Lives here rather than in spells/ because the
// dispatcher table is item-script-shaped.
import { buildSpellFieldScript } from '../../spells/_field-helpers.js';

const SCRIPT_BUILDERS = [
  buildTorch, buildLantern,
  buildPotionHeal, buildPotionCure, buildPotionRefresh,
  buildPoisonPotion, buildEodonPotion, buildEndlessDecanter, buildAreaPotion,
  buildFood, buildDrink, buildGreenThorns, buildGreenThornsSolenHole,
  buildGenderChangeToken, buildRaceChangeToken,
  buildBankCheck, buildImbueRecipeScroll, buildEventLogScroll,
  buildPowerHourScroll,
  buildBandage, buildMagicScroll,
  buildSpikeTrap, buildPressurePlate,
  buildGasTrap, buildFireColumnTrap, buildSawTrap, buildDartTrap,
  buildTeleporter, buildPeerlessAltar, buildPublicMoongate,
  buildSignPost,
  buildBilgePump, buildShipAnchor, buildShipWheel, buildCabinDoor,
  buildSeaChart, buildShipMapTable, buildDock, buildDockCrane,
  buildMooringPost, buildShipPlans, buildCannon, buildLobsterTrap, buildCrabTrap,
  () => buildSpellFieldScript(),

  buildVirtueAltar, buildPeerlessChaosAltar, buildHealingAltar, buildResurrectionAltar,
  buildFarmablePlant, buildPotPlantScript,
  buildReagentBag, buildMagicWand, buildRunebook, buildReadableBook, buildRepairDeed,
  buildHouseTransferDeed,
  buildHouseTeleporter,
  buildAddonDeed,
  buildKeyScript, buildSkeletonKeyScript, buildKeyRingScript,
  buildCommodityDeed,
  buildDyeTub,
  buildDisguiseKit,
  buildStaffOrb,
  buildFirstAidBelt,
  buildBola,
  buildAquarium, buildFishBowl, buildAquariumFishingNet,
  buildRecallRune,
  buildMessageInBottle, buildSosScript, buildSeaTreasureMapScript,
  buildSpyglassScript, buildBedrollScript, buildBagOfSendingScript,
  buildNameChangeDeed, buildHairRestylingDeed, buildBeardRestylingDeed,
  buildIncenseScript, buildPerfumeScript, buildNecroReagentPouch,
  // Faza F.1.2 — Bless deed family (ServUO ItemBlessDeed/ClothingBlessDeed/BlessScroll).
  buildItemBlessDeed, buildClothingBlessDeed, buildBlessScroll,
  buildTreasureChest,
  // Skill tools (double-click → matching `[skill` command).
  buildFishingPoleScript, buildPickaxeScript, buildShovelScript,
  buildHatchetScript, buildSextantScript, buildInstrumentScript,
  buildSoulstoneScript,
  // Functional crafting / world stations.
  buildAnvil, buildForge, buildLoom, buildSpinningWheel, buildOven,
  buildTinkerTools, buildCarpentryTools, buildInscriptionTools, buildAlchemyTable,
  buildFletchingStation, buildSewingMachine, buildSmithingPress,
  buildSpinningLathe, buildWritingDesk,
  buildTrainingDummy, buildCampfire, buildAnkh, buildAnkhOfSacrifice, buildBookshelf,
  // Decorative interactive addons.
  buildArcheryButte, buildBanner, buildFireplace, buildAwesomeDisturbingPortrait, buildBedOfNails,
  buildFlamingHead, buildFlamingHeadDeed, buildPickpocketDip,
  buildEasel, buildMusicBox, buildEnchantedGraniteCart, buildBlessedStatue, buildJewelryStand,
  buildAbattoirBlock, buildArcaneCircle, buildScarecrow, buildClawFootTub,
  buildMiningCart, buildSheepStatue, buildHarpsichord, buildHarpsichordRoll,
  buildRoseRug, buildSkullRug, buildFirePainting, buildShipPainting,
  buildFlourMill, buildWoodStove, buildHauntedMirror, buildTreeStump,
  buildHagStew, buildSolenAntHole, buildFountainAddon, buildFountainOfLife, buildDolphinRug,
  // Server parity #5: cleanup-britannia turn-in.
  buildTrashBarrel,
  buildSalvageBag,
  buildFillableContainer,
  buildCommunicationCrystal,
  buildVendorRentalContract,
  buildMoonstone, buildMoonstoneGate,
  buildImprisonedMobile,
  buildCleanupAddonContainer,
  buildMahjongSet, buildDiceRoll, buildDiceCup, buildCardsGame, buildBoardGame,
  buildBallotBox, buildPlayerBulletinBoard,
  // Server parity #4: faction sigils.
  buildSigilScript,
  // Server parity #8 #1: Imbuing Soulforge crafting station.
  buildSoulforge,
  // Server parity #8 #9 reward chain — Heartwood reward bag.
  buildHeartwoodRewardBag,
  buildSpellSchemaCodexScript, buildCustomSpellScrollScript, buildSpellcraftKnowledgeScript,
  // Audit #35 P3 #16 — Bracelet of Binding artifact (recall jewelry).
  buildBraceletBinding,
  // "Missing" batch 2026-05-14 — ServUO content items previously
  // referenced by `script: '…'` in functional.js but unimplemented.
  buildInteriorDecorator, buildMannequinDeed,
  buildMovingCrate, buildHouseRaffleStone, buildChestOfSending, buildBallOfSummoning,
  buildRerollArtifact, buildMultiTool,
  buildTreasureTrinket, buildRopeOfAscension,
  buildPetBondingDeed, buildRefreshStone,
  buildHeritageTokenBag, buildTokunoPigmentSack, buildSanctuaryRewardBag,
  buildSwitch, buildSecretDoor, buildSlidingDoor, buildPortcullis,
  buildDespiseAnkh, buildSpiderWeb, buildAcidVine, buildWorldTrap,
  buildXmlTileTrap,
  buildChickenCoop, buildHitchingPost, buildIncubator, buildIncubatorEgg,
  // Khaldun + Doom puzzle furniture.
  buildPuzzleChest, buildRaisableItem, buildRaiseSwitch, buildDoomLever,
  // ServUO P1 item parity: quest timers, special tiles, sockets, pet whistle,
  // durable-item fortification, and small internal effect helpers.
  buildSpikedEggNog, buildIcyPatch, buildKronusScroll,
  buildCaddelliteInfuser, buildKhaldunTastyTreat, buildObsidianStatue,
  buildSecretWall, buildSecretSwitch, buildShimmeringCrystals, buildMaabusCoffin,
  buildPowderOfFortifying, buildPetWhistle, buildGiftBoxNeon, buildTormentedChains,
  buildSecretChest, buildServUOEthereal, buildServUOFreeTimer, buildServUOP1Marker,
];

/**
 * Build each script with the supplied `api` (so handlers close over
 * api.protocol / api.combat / api.statusEffects) and register them.
 * Returns the list of registered names so the caller can use them as
 * disposer keys.
 *
 * @param {*} api
 * @returns {string[]}
 */
export function registerAllItemScripts(api) {
  const names = [];
  for (const build of SCRIPT_BUILDERS) {
    try {
      const script = build(api);
      api.itemScripts?.register?.(script);
      names.push(script.name);
    } catch (e) {
      api.log?.(`item-scripts: ${build.name ?? 'anonymous'} failed: ${e.message}`);
    }
  }
  // Item-scripts that ship companion text commands register them
  // alongside the script. Book-recall and moongate-pick use this hook.
  try { registerBookCommand(api); }
  catch (e) { api.log?.(`runebook: ${e.message}`); }
  try { registerMoongateCommand(api); }
  catch (e) { api.log?.(`moongate cmd: ${e.message}`); }
  try { registerServUOP1Commands(api); }
  catch (e) { api.log?.(`servuo-p1-items cmd: ${e.message}`); }
  return names;
}
