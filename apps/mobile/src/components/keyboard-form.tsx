import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Ref, type RefObject } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardEvent,
  type ScrollViewProps,
  type TextInputProps,
} from 'react-native';

import { Space, Type, useAppColors } from '@/constants/theme';
import { getInputRevealOffset, getKeyboardToolbarBottom } from '@/domain/keyboard-layout';

const TOOLBAR_HEIGHT = 44;
type KeyboardFormProps = ScrollViewProps & { inputRef?: RefObject<TextInput | null> };
type FormFocus = { focus: (input: TextInput) => void; blur: (input: TextInput) => void; reveal: () => void };
const FormFocusContext = createContext<FormFocus | null>(null);

/** Every input participates in focus/selection handling, including switching to
 * another field while the keyboard is already open (which emits no show event). */
export function KeyboardTextInput({ ref, onFocus, onBlur, onSelectionChange, onContentSizeChange, ...props }: TextInputProps & { ref?: Ref<TextInput> }) {
  const focus = useContext(FormFocusContext);
  const localRef = useRef<TextInput | null>(null);
  const attachRef = useCallback((input: TextInput | null) => {
    localRef.current = input;
    if (typeof ref === 'function') ref(input);
    else if (ref) ref.current = input;
  }, [ref]);

  return (
    <TextInput
      {...props}
      ref={attachRef}
      onFocus={event => { if (localRef.current) focus?.focus(localRef.current); onFocus?.(event); }}
      onBlur={event => { if (localRef.current) focus?.blur(localRef.current); onBlur?.(event); }}
      onSelectionChange={event => { focus?.reveal(); onSelectionChange?.(event); }}
      onContentSizeChange={event => { focus?.reveal(); onContentSizeChange?.(event); }}
    />
  );
}

/** iOS owns its keyboard inset natively, in window coordinates. Do not combine
 * this with KeyboardAvoidingView: its parent-relative frame undercounts overlap
 * inside a pageSheet or below a fixed header. Android already resizes its window. */
export function KeyboardForm({ children, contentContainerStyle, inputRef, style, ...props }: KeyboardFormProps) {
  const c = useAppColors();
  const rootRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);
  const activeInput = useRef<TextInput | null>(null);
  const scrollY = useRef(0);
  const keyboardTop = useRef(Number.POSITIVE_INFINITY);
  const keyboardIsShown = useRef(false);
  const revealFrame = useRef<number | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const [toolbar, setToolbar] = useState({ visible: false, bottom: 0 });

  const currentInput = useCallback(() => activeInput.current ?? inputRef?.current ?? null, [inputRef]);

  const positionToolbar = useCallback(() => {
    const input = currentInput();
    if (!keyboardIsShown.current || !input?.isFocused() || Platform.OS === 'web') {
      setToolbar(previous => previous.visible ? { visible: false, bottom: 0 } : previous);
      return;
    }
    rootRef.current?.measureInWindow((_x, top, _width, height) => {
      if (!mounted.current || !keyboardIsShown.current || !input.isFocused()) return;
      const bottom = getKeyboardToolbarBottom(top, height, keyboardTop.current);
      setToolbar(previous => previous.visible && previous.bottom === bottom ? previous : { visible: true, bottom });
    });
  }, [currentInput]);

  const revealInput = useCallback(() => {
    const input = currentInput();
    const scroll = scrollRef.current;
    if (!input?.isFocused() || !scroll || Platform.OS === 'web') return;
    positionToolbar();
    scroll.getNativeScrollRef()?.measureInWindow((_x, top, _width, height) => {
      input.measureInWindow((_inputX, inputTop, _inputWidth, inputHeight) => {
        if (!mounted.current || !input.isFocused() || currentInput() !== input || !scrollRef.current) return;
        const y = getInputRevealOffset({
          inputTop,
          inputHeight,
          viewportTop: top,
          viewportHeight: height,
          keyboardTop: keyboardTop.current,
          scrollY: scrollY.current,
          gap: Space.md,
          bottomObstruction: keyboardIsShown.current ? TOOLBAR_HEIGHT : 0,
        });
        if (Math.abs(y - scrollY.current) > 1) scrollRef.current.scrollTo({ y, animated: true });
      });
    });
  }, [currentInput, positionToolbar]);

  const scheduleReveal = useCallback((delay = 0) => {
    if (Platform.OS === 'web') return;
    if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
    if (revealTimer.current !== null) clearTimeout(revealTimer.current);
    const nextFrame = () => {
      revealTimer.current = null;
      revealFrame.current = requestAnimationFrame(() => {
        revealFrame.current = null;
        revealInput();
      });
    };
    if (delay > 0) revealTimer.current = setTimeout(nextFrame, delay);
    else nextFrame();
  }, [revealInput]);

  useEffect(() => {
    mounted.current = true;
    // RN Web has no Keyboard.metrics implementation; the browser handles its
    // visual viewport and must retain focus while it scrolls fields into view.
    if (Platform.OS === 'web') return;
    const metrics = Keyboard.metrics();
    keyboardIsShown.current = Keyboard.isVisible();
    keyboardTop.current = metrics?.screenY ?? Number.POSITIVE_INFINITY;
    const change = (event: KeyboardEvent, waitForAnimation = false) => {
      keyboardTop.current = event.endCoordinates.screenY;
      keyboardIsShown.current = event.endCoordinates.height > 0;
      positionToolbar();
      // Native iOS insets animate first. Measure again after that movement, not
      // against an intermediate frame that may be replaced by the native scroll.
      scheduleReveal(waitForAnimation ? event.duration + 32 : 0);
    };
    const hide = () => {
      keyboardTop.current = Number.POSITIVE_INFINITY;
      keyboardIsShown.current = false;
      positionToolbar();
    };
    const subscriptions = [
      Keyboard.addListener('keyboardDidShow', event => change(event)),
      Keyboard.addListener('keyboardDidHide', hide),
      ...(Platform.OS === 'ios' ? [
        Keyboard.addListener('keyboardWillChangeFrame', event => change(event, true)),
        Keyboard.addListener('keyboardDidChangeFrame', event => change(event)),
        Keyboard.addListener('keyboardWillHide', hide),
      ] : []),
    ];
    return () => {
      mounted.current = false;
      subscriptions.forEach(subscription => subscription.remove());
      if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
      if (revealTimer.current !== null) clearTimeout(revealTimer.current);
    };
  }, [positionToolbar, scheduleReveal]);

  const focus = useMemo<FormFocus>(() => ({
    focus: input => { activeInput.current = input; positionToolbar(); scheduleReveal(); },
    blur: input => { if (activeInput.current === input) activeInput.current = null; positionToolbar(); },
    reveal: () => scheduleReveal(),
  }), [positionToolbar, scheduleReveal]);

  return (
    <FormFocusContext.Provider value={focus}>
      <View ref={rootRef} style={[styles.page, { backgroundColor: c.ground }, style]} onLayout={() => { positionToolbar(); scheduleReveal(); }}>
        <ScrollView
          {...props}
          ref={scrollRef}
          style={styles.scroll}
          contentContainerStyle={[styles.content, contentContainerStyle]}
          automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'}
          keyboardShouldPersistTaps="handled"
          // RN Web's on-drag mode blurs inputs even on browser focus auto-scroll.
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : Platform.OS === 'android' ? 'on-drag' : 'none'}
          onLayout={event => { props.onLayout?.(event); scheduleReveal(); }}
          onContentSizeChange={(width, height) => { props.onContentSizeChange?.(width, height); scheduleReveal(); }}
          onScroll={event => { scrollY.current = event.nativeEvent.contentOffset.y; props.onScroll?.(event); }}
          scrollEventThrottle={16}>
          {children}
          {toolbar.visible && <View style={styles.toolbarScrollSpace} />}
        </ScrollView>
        {toolbar.visible && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss keyboard"
            onPress={Keyboard.dismiss}
            style={[styles.dismiss, { bottom: toolbar.bottom, backgroundColor: c.wool, borderTopColor: c.seam }]}>
            <Text style={[styles.dismissText, { color: c.ember }]}>Done typing</Text>
          </Pressable>
        )}
      </View>
    </FormFocusContext.Provider>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0 },
  scroll: { flex: 1, minHeight: 0 },
  content: { flexGrow: 1 },
  toolbarScrollSpace: { height: TOOLBAR_HEIGHT + Space.md, flexShrink: 0 },
  dismiss: { position: 'absolute', left: 0, right: 0, height: TOOLBAR_HEIGHT, justifyContent: 'center', alignItems: 'flex-end', paddingHorizontal: Space.lg, borderTopWidth: 1 },
  dismissText: { ...Type.control },
});
