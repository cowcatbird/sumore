import { router } from 'expo-router';
import { useEffect, useId, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Defs, Ellipse, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

import { CharacterSprite, HatSprite } from '@/components/character-sprite';
import { CampsiteThumbnail } from '@/components/campsite-thumbnail';
import { SMoreSprite } from '@/components/smore-sprite';
import { FormLayout } from '@/constants/form-layout';
import { MaxContentWidth, Radius, Space, Type } from '@/constants/theme';
import { BODY_COLORS, HATS, defaultAppearance, type BodyColorId, type HatId } from '@/domain/character';
import { canPurchaseShopItem, hasShopUnlock, hatShopItem, orderedHats, SHOP_ITEMS, type BackgroundId, type ShopItemId } from '@/domain/circle-shop';
import { useApp } from '@/features/app-store';
import { useCharacter } from '@/features/character-store';

const palette = {
  night: '#0A151D',
  surface: '#12232A',
  inset: '#0C1B22',
  seam: '#293E43',
  cream: '#FFF3DE',
  muted: '#AABDBA',
  ember: '#FFAD66',
  warm: '#362B25',
  mint: '#A9CEB7',
};

const backgrounds = [
  { id: 'forest', label: 'Forest', image: require('../../assets/campsite/background.png') },
  { id: 'beach', label: 'Beach', image: require('../../assets/campsite/background-beach.png') },
  { id: 'snow', label: 'Snow', image: require('../../assets/campsite/background-snow.png') },
] as const;

export default function CustomizeScreen() {
  const { profile, circleShop } = useApp();
  // Replacing the group/account also replaces pending confirmations and edits.
  return <CustomizeSession key={`${profile.id}:${circleShop?.id ?? 'unavailable'}`} />;
}

function CustomizeSession() {
  const { appearance, setAppearance, loaded, status, error, retrySave, sharedMode, shared } = useCharacter();
  const { campfire, circleShop, purchaseItem, setBackground, busy } = useApp();
  const ownSeat = campfire.seats.find((seat) => seat.isYou);
  const burnt = ownSeat?.askedToday ?? false;
  const insets = useSafeAreaInsets();
  const { width: viewportWidth, fontScale } = useWindowDimensions();
  const hatLabel = HATS.find(({ id }) => id === appearance.hat)?.label ?? 'None';
  const [confirmItem, setConfirmItem] = useState<ShopItemId | null>(null);
  const [shopping, setShopping] = useState(false);
  const [shopError, setShopError] = useState<string | null>(null);
  const [hatGridWidth, setHatGridWidth] = useState(0);
  const [colorGridWidth, setColorGridWidth] = useState(0);
  const [backgroundGridWidth, setBackgroundGridWidth] = useState(0);
  const shoppingRef = useRef(false);
  const mountedRef = useRef(true);
  const disabled = !loaded || busy || shopping;
  const listing = SHOP_ITEMS.find(({ id }) => id === confirmItem);
  const affordable = !!confirmItem && canPurchaseShopItem(circleShop, confirmItem);
  const contentWidth = Math.max(0, Math.min(viewportWidth, MaxContentWidth) - Space.md * 2);
  const cardScale = Math.max(1, fontScale);
  const hatCardWidth = equalCardWidth(hatGridWidth || contentWidth, 92 * cardScale, 3);
  const colorCardWidth = equalCardWidth(colorGridWidth || contentWidth, 92 * cardScale, 3);
  const campsiteCardWidth = equalCardWidth(backgroundGridWidth || contentWidth, 132 * cardScale, 2);
  const bodyCardWidth = equalCardWidth(hatGridWidth || contentWidth, 124 * cardScale, 2);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  async function equip(item: ShopItemId) {
    if (item.startsWith('hat:')) setAppearance({ hat: item.slice('hat:'.length) as HatId });
    else if (item.startsWith('background:')) await setBackground(item.slice('background:'.length) as BackgroundId);
    else setAppearance({ color: item.slice('color:'.length) as BodyColorId });
  }

  async function chooseItem(item: ShopItemId) {
    if (disabled || shoppingRef.current) return;
    setShopError(null);
    if (!hasShopUnlock(circleShop, item)) {
      if (!circleShop) setShopError('The shop is unavailable. Try again when connected.');
      else setConfirmItem(item);
      return;
    }
    shoppingRef.current = true;
    setShopping(true);
    try {
      await equip(item);
    } catch (caught) {
      if (mountedRef.current) {
        setShopError(caught instanceof Error ? caught.message : 'Could not update your camper. Try again.');
      }
    } finally {
      shoppingRef.current = false;
      if (mountedRef.current) setShopping(false);
    }
  }

  async function buyItem() {
    if (!confirmItem || !circleShop || !affordable || disabled || shoppingRef.current) return;
    const item = confirmItem;
    shoppingRef.current = true;
    setShopping(true);
    setShopError(null);
    try {
      await purchaseItem(item);
      // A membership/account change during purchase must not equip the new group.
      if (!mountedRef.current) return;
      setConfirmItem(null);
      await equip(item);
    } catch (caught) {
      if (mountedRef.current) {
        setShopError(caught instanceof Error ? caught.message : 'Could not unlock this item. Try again.');
      }
    } finally {
      shoppingRef.current = false;
      if (mountedRef.current) setShopping(false);
    }
  }

  async function chooseBackground(background: BackgroundId) {
    if (background !== 'forest') return chooseItem(`background:${background}`);
    if (disabled || shoppingRef.current || !circleShop) return;
    shoppingRef.current = true;
    setShopping(true);
    setShopError(null);
    try {
      await setBackground(background);
    } catch (caught) {
      if (mountedRef.current) {
        setShopError(caught instanceof Error ? caught.message : 'Could not change the campsite. Try again.');
      }
    } finally {
      shoppingRef.current = false;
      if (mountedRef.current) setShopping(false);
    }
  }

  return (
    <View style={styles.page}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + Space.lg, paddingBottom: insets.bottom + Space.xxl }]}
        showsVerticalScrollIndicator={false}>
        <View style={styles.heading}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back to Camp" onPress={() => router.replace('/')}
            style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}>
            <Text allowFontScaling={false} style={styles.backText}>‹</Text>
          </Pressable>
          <Text accessibilityRole="header" style={styles.title}>Your camper</Text>
        </View>

        <View style={styles.camperSummary}>
          <View style={styles.wallet} accessibilityLabel={circleShop ? `Circle wallet: ${circleShop.balance} s’mores, shared with everyone in your circle` : 'Circle shop unavailable'}>
            <View style={styles.walletLabel}>
              <Text style={styles.walletTitle}>Circle wallet</Text>
              <Text style={styles.walletHint}>{circleShop ? 'Shared with your circle' : 'Connect to open the shop'}</Text>
            </View>
            <View style={styles.walletAmount}>
              <Text style={styles.walletBalance}>{circleShop?.balance ?? '…'}</Text>
              <SMoreSprite size={40} decorative />
            </View>
          </View>
          {shopError && !confirmItem && <Text accessibilityRole="alert" style={styles.shopError}>{shopError}</Text>}

          <View style={styles.previewCard}>
            <View
              accessibilityLabel={`Your ${appearance.body} camper, ${appearance.hat === 'none' ? 'no hat' : `${hatLabel} headwear`}, ${burnt ? 'burnt' : 'fresh'} marshmallow`}
              accessibilityRole="image"
              style={styles.stage}>
              <PreviewAtmosphere />
              {loaded ? (
                <CharacterSprite appearance={appearance} burnt={burnt} size={166} lighting={0.8} />
              ) : (
                <ActivityIndicator color={palette.ember} accessibilityLabel="Loading your camper" />
              )}
            </View>
            <View style={styles.previewCaption}>
              <Text style={styles.lookName}>{appearance.hat === 'none' ? 'No hat' : hatLabel}</Text>
            </View>
          </View>

          <View accessibilityLiveRegion="polite" style={styles.saveNotice}>
            <View style={styles.statusIcon}>
              {status === 'loading' || status === 'saving' ? (
                <ActivityIndicator color={palette.ember} size="small" />
              ) : <View style={[styles.statusDot, status === 'error' && styles.errorDot]} />}
            </View>
            <Text style={[styles.saveText, status === 'error' && styles.errorText]}>
              {status === 'loading'
                ? 'Loading…'
                : status === 'saving'
                  ? sharedMode ? 'Sharing…' : 'Saving…'
                  : status === 'saved'
                    ? shared ? 'Shared with your circle' : 'Saved on this device'
                    : status === 'error'
                      ? error
                      : sharedMode ? 'Ready' : 'Ready on this device'}
            </Text>
            {status === 'error' && (
              <Pressable accessibilityRole="button" onPress={retrySave} style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            )}
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeading title="Hats" />
          <View style={styles.hatGrid} onLayout={({ nativeEvent }) => setHatGridWidth(nativeEvent.layout.width)}>
            {orderedHats(circleShop).map((hat) => {
              const selected = appearance.hat === hat.id;
              const item = hatShopItem(hat.id);
              const locked = !!item && !hasShopUnlock(circleShop, item.id);
              return (
                <Pressable
                  key={hat.id}
                  accessibilityRole="radio"
                  accessibilityLabel={`${hat.label} headwear${locked ? `, locked, ${item.cost} s’mores for your circle` : ''}`}
                  accessibilityState={{ checked: selected, selected, disabled }}
                  disabled={disabled}
                  onPress={() => item ? void chooseItem(item.id) : setAppearance({ hat: hat.id })}
                  style={({ pressed }) => [styles.hatOption, { width: hatCardWidth }, selected && styles.selected, pressed && styles.pressed, disabled && styles.disabled]}>
                  {selected && <View style={styles.checkBadge} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                    <Svg width={12} height={12} viewBox="0 0 12 12"><Path d="m2.4 6 2.3 2.4 4.9-4.8" fill="none" stroke={palette.night} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" /></Svg>
                  </View>}
                  <View style={[styles.hatArt, (hat.id === 'top-hat' || hat.id === 'sunglasses' || hat.id === 'disguise-glasses') && styles.darkHatArt]}>
                    {hat.id === 'none' ? (
                      <View style={styles.noHat}><Text allowFontScaling={false} style={styles.noHatText}>×</Text></View>
                    ) : <HatSprite hat={hat.id} size={70} />}
                  </View>
                  <Text style={[styles.optionLabel, selected && styles.selectedText]}>{hat.label}</Text>
                  <View style={styles.hatPriceSlot}>{locked && <PriceBadge cost={item.cost} />}</View>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeading title="Body" />
          <View style={styles.choiceRow}>
            {(['short', 'tall'] as const).map((body) => {
              const selected = appearance.body === body;
              return (
                <Pressable
                  key={body}
                  accessibilityRole="radio"
                  accessibilityLabel={`${body === 'short' ? 'Short' : 'Tall'} body`}
                  accessibilityState={{ checked: selected, selected, disabled }}
                  disabled={disabled}
                  onPress={() => setAppearance({ body })}
                  style={({ pressed }) => [styles.bodyOption, { width: bodyCardWidth }, selected && styles.selected, pressed && styles.pressed, disabled && styles.disabled]}>
                  <View style={styles.bodyArt}>
                    <CharacterSprite appearance={{ ...defaultAppearance, body, color: appearance.color }} size={57} lighting={0.65} showMarshmallow={false} />
                  </View>
                  <View style={styles.bodyCaption}>
                    <Text style={[styles.optionLabel, styles.captionLabel, selected && styles.selectedText]}>{body === 'short' ? 'Short' : 'Tall'}</Text>
                    <SelectionRing selected={selected} />
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeading title="Colors" />
          <View style={styles.colorRow} onLayout={(event) => setColorGridWidth(event.nativeEvent.layout.width)}>
            {BODY_COLORS.map((color) => {
              const selected = (appearance.color ?? 'cream') === color.id;
              const item: ShopItemId | null = color.id === 'cream' ? null : `color:${color.id}`;
              const locked = !!item && !hasShopUnlock(circleShop, item);
              const price = SHOP_ITEMS.find(listing => listing.id === item)?.cost;
              return <Pressable key={color.id} accessibilityRole="radio"
                accessibilityLabel={`${color.label}${locked ? `, locked, ${price} s’mores for your circle` : ''}`}
                accessibilityState={{ checked: selected, selected, disabled }} disabled={disabled}
                onPress={() => item ? void chooseItem(item) : setAppearance({ color: 'cream' })}
                style={({ pressed }) => [styles.colorOption, { width: colorCardWidth }, selected && styles.selected, pressed && styles.pressed, disabled && styles.disabled]}>
                <View style={[styles.colorSwatch, { backgroundColor: color.hex }]}>{selected && <Text allowFontScaling={false} style={styles.swatchCheck}>✓</Text>}</View>
                <Text style={[styles.optionLabel, selected && styles.selectedText]}>{color.id.charAt(0).toUpperCase() + color.id.slice(1)}</Text>
                <View style={styles.hatPriceSlot}>{locked && price !== undefined && <PriceBadge cost={price} />}</View>
              </Pressable>;
            })}
          </View>
        </View>

        <View style={styles.section}>
          <SectionHeading title="Campsite" />
          <View style={styles.backgroundGrid} onLayout={(event) => setBackgroundGridWidth(event.nativeEvent.layout.width)}>
            {backgrounds.map((background) => {
              const selected = (circleShop?.background ?? 'forest') === background.id;
              const item = SHOP_ITEMS.find(listing => listing.id === `background:${background.id}`);
              const locked = !!item && !hasShopUnlock(circleShop, item.id);
              return <Pressable key={background.id} accessibilityRole="radio"
                accessibilityLabel={`${background.label} campsite${locked ? `, locked, ${item.cost} s’mores for your circle` : ''}`}
                accessibilityState={{ checked: selected, selected, disabled: disabled || !circleShop }} disabled={disabled || !circleShop}
                onPress={() => void chooseBackground(background.id)}
                style={({ pressed }) => [styles.backgroundOption, { width: campsiteCardWidth }, selected && styles.selected, pressed && styles.pressed, (disabled || !circleShop) && styles.disabled]}>
                <CampsiteThumbnail source={background.image} sourceWidth={background.id === 'snow' ? 1139 : 1080} />
                <View style={styles.backgroundCaption}>
                  <Text style={[styles.optionLabel, styles.captionLabel, selected && styles.selectedText]}>{background.label}</Text>
                  {locked && item ? <PriceBadge cost={item.cost} /> : <SelectionRing selected={selected} />}
                </View>
              </Pressable>;
            })}
          </View>
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => router.replace('/')}
          style={({ pressed }) => [styles.returnButton, pressed && styles.pressed]}>
          <Text style={styles.returnText}>Back to the fire</Text>
          <Text style={styles.returnArrow}>↗</Text>
        </Pressable>
      </ScrollView>
      <Modal visible={!!listing} transparent animationType="fade" onRequestClose={() => { if (!shopping) setConfirmItem(null); }}>
        {listing && <View style={[styles.modalBackdrop, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 20 }]}>
          <ScrollView accessibilityViewIsModal style={styles.confirmScroll} contentContainerStyle={styles.confirmCard} bounces={false}>
            <Text accessibilityRole="header" style={styles.confirmTitle}>Unlock {listing?.label.toLowerCase()}?</Text>
            <Text style={styles.confirmDetail}>For everyone in your circle.</Text>
            <View style={styles.confirmPrice}><Text style={styles.confirmAmount}>{listing?.cost}</Text><SMoreSprite size={55} decorative /></View>
            <Text style={styles.confirmBalance}>Circle balance: {circleShop?.balance ?? 0} s’mores</Text>
            {!affordable && !shopping && <Text style={styles.shopError}>{confirmItem && hasShopUnlock(circleShop, confirmItem) ? 'Your circle already owns this.' : 'Not enough s’mores yet.'}</Text>}
            {shopError && <Text accessibilityRole="alert" style={styles.shopError}>{shopError}</Text>}
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: !affordable || disabled }}
              disabled={!affordable || disabled} onPress={() => void buyItem()}
              style={({ pressed }) => [styles.confirmButton, (!affordable || disabled) && styles.disabled, pressed && styles.pressed]}>
              {shopping ? <ActivityIndicator color={palette.night} /> : <Text style={styles.returnText}>Unlock for everyone</Text>}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: shopping }} disabled={shopping}
              onPress={() => { setConfirmItem(null); setShopError(null); }} style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}>
              <Text style={styles.cancelText}>Not now</Text>
            </Pressable>
          </ScrollView>
        </View>}
      </Modal>
    </View>
  );
}

/** Equal-width rows stay left aligned; larger text gets fewer, wider cards. */
function equalCardWidth(availableWidth: number, minimumWidth: number, maxColumns: number) {
  const columns = Math.max(1, Math.min(maxColumns, Math.floor((availableWidth + Space.sm) / (minimumWidth + Space.sm))));
  return (availableWidth - Space.sm * (columns - 1)) / columns;
}

function PriceBadge({ cost }: { cost: number }) {
  return <View style={styles.priceBadge} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Svg width={12} height={14} viewBox="0 0 10 12" pointerEvents="none">
      <Path d="M3 5V3a2 2 0 014 0v2" fill="none" stroke="#FFD3A1" strokeWidth={1.25} />
      <Rect x={1.5} y={5} width={7} height={5.5} rx={1.2} fill="none" stroke="#FFD3A1" strokeWidth={1.25} />
    </Svg>
    <Text style={styles.priceText}>{cost}</Text><SMoreSprite size={22} decorative />
  </View>;
}

function PreviewAtmosphere() {
  const id = `wardrobe-${useId().replace(/:/g, '')}`;
  return (
    <Svg width="100%" height="100%" viewBox="0 0 500 270" preserveAspectRatio="none" style={StyleSheet.absoluteFill} pointerEvents="none">
      <Defs>
        <RadialGradient id={id} cx="50%" cy="75%" r="60%">
          <Stop offset="0" stopColor="#D27D40" stopOpacity={0.19} />
          <Stop offset="1" stopColor="#D27D40" stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Rect width={500} height={270} fill={`url(#${id})`} />
      <Ellipse cx={250} cy={244} rx={92} ry={11} fill="#000B11" opacity={0.42} />
      <Ellipse cx={250} cy={242} rx={65} ry={7} fill="#000B11" opacity={0.42} />
      <Circle cx={69} cy={77} r={1.6} fill="#D6DCCE" opacity={0.6} />
      <Circle cx={127} cy={34} r={1} fill="#D6DCCE" opacity={0.4} />
      <Circle cx={383} cy={43} r={1.9} fill="#D6DCCE" opacity={0.6} />
      <Circle cx={434} cy={113} r={1} fill="#D6DCCE" opacity={0.5} />
    </Svg>
  );
}

function SectionHeading({ title }: { title: string }) {
  return <View style={styles.sectionHeading}>
    <Text accessibilityRole="header" style={styles.sectionTitle}>{title}</Text>
    <View style={styles.sectionRule} />
  </View>;
}

function SelectionRing({ selected }: { selected: boolean }) {
  return <View style={[styles.selectionRing, selected && styles.selectionRingActive]}>{selected && <View style={styles.selectionFill} />}</View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.night },
  content: { width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center', paddingHorizontal: Space.md, gap: Space.xl },
  heading: { flexDirection: 'row', alignItems: 'center', gap: Space.sm },
  backButton: { width: 44, minHeight: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.fold, backgroundColor: palette.inset, borderWidth: 1, borderColor: palette.seam },
  backText: { color: palette.cream, fontSize: 28, lineHeight: 32 },
  title: { ...Type.title, flex: 1, minWidth: 0, color: palette.cream },
  camperSummary: { gap: Space.sm },
  previewCard: { backgroundColor: palette.surface, borderRadius: Radius.blanket, borderWidth: 1, borderColor: palette.seam, overflow: 'hidden' },
  stage: { height: 250, alignItems: 'center', justifyContent: 'center' },
  previewCaption: { alignItems: 'center', paddingHorizontal: Space.md, paddingVertical: Space.sm, backgroundColor: palette.inset, borderTopWidth: 1, borderTopColor: palette.seam },
  lookName: { ...Type.control, color: palette.cream, textAlign: 'center' },
  // Keep the spinner and saved indicator in the same footprint so the grid never jumps.
  saveNotice: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: Space.xs, paddingHorizontal: Space.xs },
  statusIcon: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  statusDot: { width: 6, height: 6, borderRadius: Radius.coal, backgroundColor: palette.mint },
  errorDot: { backgroundColor: palette.ember },
  saveText: { ...Type.bodySmall, flex: 1, minWidth: 0, color: palette.muted },
  errorText: { color: palette.ember },
  retry: { minHeight: 44, paddingHorizontal: Space.sm, paddingVertical: Space.xs, borderRadius: Radius.tin, justifyContent: 'center' },
  retryText: { color: palette.ember, fontSize: 13, fontWeight: '700' },
  section: { gap: Space.md },
  sectionHeading: { flexDirection: 'row', gap: Space.md, alignItems: 'center' },
  sectionTitle: { ...Type.heading, color: palette.cream, flexShrink: 1 },
  sectionRule: { flex: 1, minWidth: Space.lg, height: 1, backgroundColor: palette.seam },
  hatGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-start', gap: Space.sm },
  hatOption: { flexGrow: 0, flexShrink: 0, minHeight: 172, borderRadius: Radius.fold, borderWidth: 1, borderColor: palette.seam, backgroundColor: palette.inset, alignItems: 'center', gap: Space.xs, paddingHorizontal: Space.xs, paddingTop: Space.lg, paddingBottom: Space.sm },
  hatPriceSlot: { minHeight: 28, marginTop: 'auto', maxWidth: '100%', justifyContent: 'center' },
  selected: { backgroundColor: palette.warm, borderColor: palette.ember },
  hatArt: { height: 61, justifyContent: 'center', alignItems: 'center' },
  darkHatArt: { width: 70, borderRadius: Radius.tin, backgroundColor: '#9AAEA91F' },
  noHat: { width: 40, height: 40, borderRadius: Radius.coal, borderWidth: 1.5, borderColor: palette.muted, alignItems: 'center', justifyContent: 'center' },
  noHatText: { color: palette.muted, fontSize: 21, lineHeight: 25 },
  optionLabel: { color: palette.cream, fontSize: 13, lineHeight: 18, fontWeight: '700', letterSpacing: 0.1, textAlign: 'center', maxWidth: '100%' },
  captionLabel: { flexGrow: 1, flexShrink: 1, minWidth: 0, textAlign: 'left' },
  selectedText: { color: '#FFD3A1' },
  checkBadge: { position: 'absolute', right: Space.xs, top: Space.xs, width: 20, height: 20, borderRadius: Radius.coal, backgroundColor: palette.ember, justifyContent: 'center', alignItems: 'center' },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm },
  bodyOption: { flexGrow: 0, flexShrink: 0, alignItems: 'center', minHeight: 148, gap: Space.sm, borderWidth: 1, borderColor: palette.seam, backgroundColor: palette.inset, borderRadius: Radius.fold, padding: Space.md },
  bodyArt: { width: 80, height: 80, justifyContent: 'center', alignItems: 'center' },
  bodyCaption: { flexDirection: 'row', width: '100%', alignItems: 'center', gap: Space.xs },
  selectionRing: { width: 18, height: 18, flexShrink: 0, borderRadius: Radius.coal, borderWidth: 1.5, borderColor: '#657A7A', alignItems: 'center', justifyContent: 'center' },
  selectionRingActive: { borderColor: palette.ember },
  selectionFill: { width: 8, height: 8, borderRadius: Radius.coal, backgroundColor: palette.ember },
  returnButton: { minHeight: FormLayout.controlHeight, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Space.sm, paddingHorizontal: Space.md, paddingVertical: Space.sm, backgroundColor: palette.ember, borderRadius: FormLayout.controlRadius },
  returnText: { color: '#241D16', fontSize: 14, lineHeight: 20, fontWeight: '800', flexShrink: 1, textAlign: 'center' },
  returnArrow: { color: '#241D16', fontSize: 19, fontWeight: '600' },
  pressed: { opacity: 0.88, transform: [{ scale: 0.985 }] },
  disabled: { opacity: 0.48 },
  wallet: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: Space.sm, backgroundColor: palette.inset, borderColor: palette.seam, borderWidth: 1, borderRadius: Radius.fold, padding: Space.md },
  walletLabel: { flex: 1, minWidth: 120, gap: 4 },
  walletTitle: { color: palette.cream, fontSize: 14, fontWeight: '700' },
  walletHint: { color: palette.muted, fontSize: 12, lineHeight: 17 },
  walletAmount: { flexDirection: 'row', flexShrink: 1, maxWidth: '100%', alignItems: 'center', gap: Space.xs, backgroundColor: palette.warm, borderColor: '#FFAD6633', borderWidth: 1, borderRadius: Radius.fold, paddingHorizontal: Space.sm, paddingVertical: 4 },
  walletBalance: { color: '#FFD3A1', fontSize: 28, lineHeight: 34, fontWeight: '800', fontVariant: ['tabular-nums'], flexShrink: 1 },
  priceBadge: { flexDirection: 'row', alignItems: 'center', gap: 3, minHeight: 28, maxWidth: '100%', backgroundColor: palette.warm, borderColor: '#FFAD6633', borderWidth: 1, borderRadius: Radius.coal, paddingHorizontal: Space.xs, paddingVertical: 2 },
  priceText: { color: '#FFD3A1', fontSize: 11, lineHeight: 16, fontWeight: '700', fontVariant: ['tabular-nums'] },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Space.sm, justifyContent: 'flex-start' },
  colorOption: { minHeight: 156, flexGrow: 0, flexShrink: 0, alignItems: 'center', gap: Space.sm, paddingVertical: Space.md, paddingHorizontal: Space.xs, borderRadius: Radius.fold, borderColor: palette.seam, borderWidth: 1, backgroundColor: palette.inset },
  colorSwatch: { width: 43, height: 43, borderRadius: Radius.coal, alignItems: 'center', justifyContent: 'center' },
  swatchCheck: { color: palette.night, fontSize: 21, fontWeight: '800' },
  backgroundGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-start', gap: Space.sm },
  backgroundOption: { flexGrow: 0, flexShrink: 0, borderWidth: 1, borderColor: palette.seam, backgroundColor: palette.inset, borderRadius: Radius.fold, overflow: 'hidden' },
  backgroundCaption: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: Space.xs, padding: Space.sm, minHeight: 64, flexGrow: 1 },
  shopError: { ...Type.bodySmall, color: '#FFBA92' },
  modalBackdrop: { flex: 1, backgroundColor: '#000A', justifyContent: 'center', alignItems: 'center', paddingHorizontal: Space.md },
  confirmScroll: { width: '100%', maxWidth: 390, flexGrow: 0, borderRadius: Radius.blanket },
  confirmCard: { backgroundColor: palette.surface, borderColor: palette.seam, borderWidth: 1, borderRadius: Radius.blanket, padding: Space.lg, gap: Space.md },
  confirmTitle: { color: palette.cream, fontSize: 25, lineHeight: 32, fontWeight: '800', letterSpacing: -0.6, textAlign: 'center' },
  confirmDetail: { ...Type.body, color: palette.muted, textAlign: 'center' },
  confirmPrice: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: Space.xs, paddingVertical: Space.xs },
  confirmAmount: { color: '#FFD3A1', fontSize: 42, fontWeight: '800', fontVariant: ['tabular-nums'] },
  confirmBalance: { ...Type.bodySmall, color: palette.muted, textAlign: 'center' },
  confirmButton: { minHeight: FormLayout.controlHeight, paddingHorizontal: Space.md, paddingVertical: Space.sm, justifyContent: 'center', alignItems: 'center', borderRadius: FormLayout.controlRadius, backgroundColor: palette.ember },
  cancelButton: { minHeight: FormLayout.controlHeight, paddingHorizontal: Space.md, paddingVertical: Space.sm, alignItems: 'center', justifyContent: 'center', borderRadius: FormLayout.controlRadius, borderWidth: 1, borderColor: palette.seam },
  cancelText: { color: palette.muted, fontSize: 14, lineHeight: 20, fontWeight: '600', textAlign: 'center' },
});
