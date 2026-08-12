export const DUDE_ANCHOR_FRAC = 0.77;
export const INITIAL_DUDE_Y_SHIFT = -0.6;
export const INITIAL_DUDE_X_SHIFT = -0.07;
export const DEFAULT_DUDE_CENTER_X = 0.4;
export const DEFAULT_DUDE_BOTTOM_Y = 0.78;
export const INITIAL_DUDE_FACING_LEFT = false;
export const ALTERNATE_DUDE_X_SHIFT = 0.27;
export const ROCK_BOX_INSET_LEFT_FRAC = 0;
export const ROCK_BOX_INSET_RIGHT_FRAC = 0;
export const ROCK_BOX_INSET_TOP_FRAC = 0.02;
export const ROCK_BOX_INSET_BOTTOM_FRAC = 0.24;
export const DUDE_SPRITE_HEIGHT_FRAC = 0.45;
export const DUDE_BOUNDS_WIDTH_FRAC = 0.12;
export const DUDE_BOUNDS_HEIGHT_FRAC = 0.22;
export const DUDE_FRAME_COUNT = 4;
export const DUDE_SHEET_ROWS = 5;
export const SAFE_POINTER_MOVE_EPS = 0.0009;
export const WALK_SUPPRESSION_HIT_COUNT = 3;
export const WALK_SUPPRESSION_RADIUS = 0.03;
export const FACING_DX_EPS = 0.006;
export const FACING_FLIP_HYST_MS = 160;
export const KEYBOARD_WALK_MAX_FRAME_DELTA_MS = 48;

export const MON_REL_X = 0.63;
export const MON_REL_Y = 0.275;
export const MON_HEIGHT_FRAC = 0.15;
export const MON_BASELINE_Y_OFFSET = 0.03;
export const MON_BOUNDS_WIDTH_FRAC = 0.115;
export const MON_BOUNDS_X_SHIFT = 0.0675;
export const MON_FRAME_COUNT = 4;

const MON_BOUNDS_WIDTH_FRAC_OVERRIDES: Record<string, number> = {
  royal_aguapwoshi_drainer: 0.09,
  omom_drainer: 0.1,
  supermetaldrop_drainer: 0.1,
  deino_drainer: 0.09,
  applecreme_angel: 0.1,
  gerp_angel: 0.1,
  goxfold_angel: 0.11,
  mowch_angel: 0.1,
  mummyfly_angel: 0.1,
  borgalo_demon: 0.095,
  notchur_demon: 0.11,
  chamgot_mystic: 0.11,
  estalibur_mystic: 0.1,
  owg_spirit: 0.1,
};

export const getMonBoundsWidthFrac = (monIdOrKey: string | null) =>
  monIdOrKey
    ? (MON_BOUNDS_WIDTH_FRAC_OVERRIDES[monIdOrKey] ?? MON_BOUNDS_WIDTH_FRAC)
    : MON_BOUNDS_WIDTH_FRAC;
