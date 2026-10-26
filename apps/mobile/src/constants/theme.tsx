import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { Appearance, Platform, type TextStyle } from 'react-native';

/**
 * sumore — the firelight world.
 *
 * The material is a point blanket: four saturated stripes woven into bright
 * cream wool, sitting on birch, blued tin, and cast iron, with an ember as the
 * only warm light. A point blanket is *not* muted; scarlet, emerald, gold, and
 * indigo are the actual dye colors, and softening them is what turns this world
 * into every other campfire app.
 *
 * Light and dark are the same objects under two different lights, never one
 * palette inverted:
 *
 * - **Light is day camp.** The blanket is the ground. Cream fills the screen,
 *   the stripes read at full saturation, and the fire is a small warm object
 *   you look *at*.
 * - **Dark is night.** The fire is the ground. Ember becomes the light source,
 *   the blanket recedes to the browns wool actually goes in low light, and the
 *   stripes only surface where the firelight reaches them.
 *
 * The consequence for tokens: `ember` gets *brighter* in dark, because it is
 * emitting rather than reflecting. The woven colors go the other way — they
 * lift just enough to stay legible on a dark ground, but every one of them
 * *loses saturation*, because dye seen by firelight is duller than dye seen at
 * noon. Chroma is the axis that must fall for wool; luminance is free to rise.
 * A woven token that gains saturation in the dark is the bug to watch for.
 */

/** Roles that mean the same thing in both lights. */
export type AppPalette = {
  /** The page itself. Cream wool by day, night ground after dark. */
  ground: string;
  /** A raised woven surface: cards, sheets, list bodies. */
  wool: string;
  /** Woven surface one step further from the fire. Inputs, wells, insets. */
  woolDeep: string;
  /** Hairline where two pieces of cloth meet. */
  seam: string;
  /** A harder edge: tin, bark, a stamped rim. */
  edge: string;

  /** Primary text. */
  ink: string;
  /** Secondary text. Warm, never gray — this is wool, not newsprint. */
  inkSoft: string;
  /** Text on ember and on the saturated stripes. */
  onFlame: string;

  /** The fire. Emits light: brighter in dark, deeper in light. */
  ember: string;
  /** Ember at rest — the ring of heat around a coal. */
  emberLow: string;
  /** The glow ember throws onto nearby wool. */
  emberWash: string;

  /** The four woven stripes, at real point-blanket saturation. */
  indigo: string;
  emerald: string;
  gold: string;
  scarlet: string;

  /** Blued tin: tags, wire, stamped plate. */
  tin: string;
  /** Tin catching light. */
  tinBright: string;

  /** Marshmallow — the thing being passed. Stays near-white in both lights. */
  mallow: string;
  /** Toasted edge. */
  toast: string;

  /** Text on the pastel avatar colors the server assigns. Never lightens. */
  onPastel: string;
};

/** Day camp. The blanket is the ground; the fire is an object on it. */
export const AppColorsLight: AppPalette = {
  ground: '#F5EFE1',
  wool: '#FFFBF2',
  woolDeep: '#EBE2CE',
  seam: '#DED3BB',
  edge: '#C3B69B',

  ink: '#1A1712',
  inkSoft: '#6B6252',
  onFlame: '#FFF8EE',

  ember: '#C4471A',
  emberLow: '#E0763C',
  emberWash: '#FBE6D3',

  indigo: '#1B3A6B',
  emerald: '#0F6B4A',
  gold: '#B5811A',
  scarlet: '#B0342A',

  tin: '#6E7681',
  tinBright: '#98A0AA',

  mallow: '#FFFDF8',
  toast: '#A9652F',

  onPastel: '#1A1712',
};

/** Night. The fire is the ground; the blanket is only what the fire reaches. */
export const AppColorsDark: AppPalette = {
  ground: '#0A151D',
  wool: '#12232A',
  woolDeep: '#0C1B22',
  seam: '#293E43',
  edge: '#405654',

  ink: '#FFF3DE',
  inkSoft: '#AABDBA',
  onFlame: '#1A1712',

  // Emitting, so it climbs in the dark instead of dimming.
  ember: '#FFAD66',
  emberLow: '#C4551F',
  emberWash: '#3A2114',

  // Woven, so it drops — these are dyes seen by firelight, not neon.
  indigo: '#2E4A78',
  emerald: '#1E7A57',
  gold: '#D19B2E',
  scarlet: '#C2493A',

  tin: '#8B939E',
  tinBright: '#B9C1CB',

  mallow: '#F7F0E4',
  toast: '#D08A47',

  onPastel: '#1A1712',
};

/**
 * One subscription to the system appearance, at the root, for the whole app.
 *
 * Every screen used to call `useColorScheme()` for itself. That produced a
 * genuinely broken state on a live light/dark switch: some subtrees re-rendered
 * and others kept the previous palette, so a screen could end up with the dark
 * palette's near-white ink sitting on the light palette's cream ground — around
 * 1.3:1, unreadable, and reachable just by walking outside at dusk with the
 * system set to automatic.
 *
 * `useSyncExternalStore` fixes it by construction rather than by diagnosis:
 * there is one store, one subscription, and one value. React guarantees every
 * consumer sees the same snapshot in the same commit, so a half-updated screen
 * is no longer expressible.
 */
function subscribeToAppearance(onChange: () => void) {
  const subscription = Appearance.addChangeListener(onChange);
  return () => subscription.remove();
}

function readScheme(): 'light' | 'dark' {
  return Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
}

/** Static rendering has no device to ask, and light is the safe first paint. */
function readServerScheme(): 'light' | 'dark' {
  return 'light';
}

const AppThemeContext = createContext<AppPalette>(AppColorsLight);

export function AppThemeProvider({ children, nightCamp = false }: { children: ReactNode; nightCamp?: boolean }) {
  const scheme = useSyncExternalStore(subscribeToAppearance, readScheme, readServerScheme);
  return (
    <AppThemeContext.Provider value={nightCamp || scheme === 'dark' ? AppColorsDark : AppColorsLight}>
      {children}
    </AppThemeContext.Provider>
  );
}

/** The palette for the current appearance. Re-renders every consumer together. */
export function useAppColors(): AppPalette {
  return useContext(AppThemeContext);
}

/** True when the fire is the light source, for the few places that must know. */
export function useIsNight(): boolean {
  return useContext(AppThemeContext) === AppColorsDark;
}

/** The four stripe dyes in weaving order, for bands and for assigning to people. */
export const stripeOrder = ['indigo', 'emerald', 'gold', 'scarlet'] as const;
export type StripeName = (typeof stripeOrder)[number];

/** Stable per-person stripe, so a friend keeps the same dye across screens. */
export function stripeFor(seed: string): StripeName {
  let total = 0;
  for (let i = 0; i < seed.length; i += 1) total += seed.charCodeAt(i);
  return stripeOrder[total % stripeOrder.length];
}

export const Space = { xs: 8, sm: 12, md: 16, lg: 24, xl: 32, xxl: 48 } as const;

/**
 * Woven goods and stamped metal have different corners, so the scale is named
 * for what it is cutting rather than for a t-shirt size.
 */
export const Radius = {
  /** Stamped tin: tags, plates, the primary action. */
  tin: 10,
  /** A folded edge on cloth. */
  fold: 16,
  /** A blanket corner. */
  blanket: 24,
  /** Fully round: coals, tags on a wire, avatars. */
  coal: 999,
} as const;

/**
 * Firelight throws a warm, offset, soft shadow — never a zero-offset halo.
 * `lit` is for the object closest to the fire; `rest` is everything else.
 */
export const Shadow = {
  rest:
    Platform.select({
      web: { boxShadow: '0 6px 16px rgba(26, 23, 18, 0.10)' },
      default: {
        shadowColor: '#1A1712',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.1,
        shadowRadius: 16,
        elevation: 3,
      },
    }) ?? {},
  lit:
    Platform.select({
      web: { boxShadow: '0 14px 34px rgba(122, 48, 12, 0.22)' },
      default: {
        shadowColor: '#7A300C',
        shadowOffset: { width: 0, height: 14 },
        shadowOpacity: 0.22,
        shadowRadius: 34,
        elevation: 8,
      },
    }) ?? {},
} as const;

/**
 * Type. One family, worked hard: the platform text face carries everything,
 * with weight and size doing the hierarchy so the voice stays quiet.
 * Tracking never passes -0.04em; display never passes 6rem.
 */
export const Type = {
  /** The one monumental moment per screen. */
  beacon: { fontSize: 46, lineHeight: 50, fontWeight: '800', letterSpacing: -1.6 },
  /** Screen titles. */
  title: { fontSize: 30, lineHeight: 35, fontWeight: '800', letterSpacing: -1 },
  /** Section and card headings. */
  heading: { fontSize: 19, lineHeight: 24, fontWeight: '700', letterSpacing: -0.3 },
  /** Body copy. */
  body: { fontSize: 15, lineHeight: 22, fontWeight: '400', letterSpacing: 0 },
  /** Secondary body. */
  bodySmall: { fontSize: 13, lineHeight: 19, fontWeight: '400', letterSpacing: 0 },
  /** Control labels. */
  control: { fontSize: 15, lineHeight: 20, fontWeight: '700', letterSpacing: -0.1 },
  /** Stamped-into-metal labels. Small, tracked, uppercase at the call site. */
  stamp: { fontSize: 11, lineHeight: 14, fontWeight: '800', letterSpacing: 1.1 },
  /** Numerals in a measured context; tabular so digits do not jitter as they tick. */
  meter: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '700',
    letterSpacing: 0.2,
    fontVariant: ['tabular-nums'],
  },
} satisfies Record<string, TextStyle>;

export const MaxContentWidth = 640;
