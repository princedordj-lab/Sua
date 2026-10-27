import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  useWindowDimensions,
  type AccessibilityActionEvent,
  type GestureResponderEvent,
} from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useSQLiteContext } from "expo-sqlite";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getSetting, setSetting } from "../lib/notes";

const FAB_SIZE = 56;
const EDGE = 12;
// Distance kept between the resting button and the top of the tab bar.
const DEFAULT_BOTTOM_OFFSET = 104;
// Normalized (0..1) position inside the draggable area. Stored as "x,y".
const POSITION_KEY = "ask_fab_position";

type Point = { x: number; y: number };
type Bounds = { minX: number; maxX: number; minY: number; maxY: number };

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function parseRatios(value: string | null): Point | null {
  if (!value) return null;
  const [rawX, rawY] = value.split(",").map((part) => Number.parseFloat(part));
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return null;
  return { x: clamp(rawX, 0, 1), y: clamp(rawY, 0, 1) };
}

/**
 * Floating "Ask Sua" assistant.
 *
 * Rendered above every authenticated screen in src/app/(app)/_layout.tsx.
 * Tap opens the assistant; drag moves it anywhere inside the safe area and the
 * spot is remembered (as a ratio, so it survives rotation and different
 * devices) in the SQLite settings KV.
 */
export function ChatFab() {
  const router = useRouter();
  const db = useSQLiteContext();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [translate] = useState(() => new Animated.ValueXY({ x: 0, y: 0 }));
  const positionRef = useRef<Point>({ x: 0, y: 0 });
  const ratiosRef = useRef<Point>({ x: 1, y: 1 });
  const dragRef = useRef({
    pageX: 0,
    pageY: 0,
    startX: 0,
    startY: 0,
    moved: false,
  });
  const [ready, setReady] = useState(false);
  const metricsRef = useRef({ height, bottom: insets.bottom });

  const bounds = useMemo<Bounds>(
    () => ({
      minX: EDGE + insets.left,
      maxX: Math.max(
        EDGE + insets.left,
        width - FAB_SIZE - EDGE - insets.right,
      ),
      minY: EDGE + insets.top,
      maxY: Math.max(
        EDGE + insets.top,
        height - FAB_SIZE - EDGE - insets.bottom,
      ),
    }),
    [height, insets.bottom, insets.left, insets.right, insets.top, width],
  );
  const boundsRef = useRef(bounds);

  // Mirror render-time measurements into refs for the gesture handlers. Refs
  // are only written in effects so the React Compiler ref rule stays happy.
  useEffect(() => {
    boundsRef.current = bounds;
  }, [bounds]);

  useEffect(() => {
    metricsRef.current = { height, bottom: insets.bottom };
  }, [height, insets.bottom]);

  const applyRatios = useCallback(
    (ratios: Point) => {
      const area = boundsRef.current;
      const spanX = area.maxX - area.minX;
      const spanY = area.maxY - area.minY;
      const point = {
        x: area.minX + ratios.x * spanX,
        y: area.minY + ratios.y * spanY,
      };
      positionRef.current = point;
      translate.setValue(point);
    },
    [translate],
  );

  // Restore the saved spot once; the default sits above the tab bar.
  useEffect(() => {
    let active = true;
    void (async () => {
      const stored = await getSetting(db, POSITION_KEY).catch(() => null);
      if (!active) return;
      const area = boundsRef.current;
      const storedRatios = parseRatios(stored);
      const spanY = Math.max(1, area.maxY - area.minY);
      const defaultY = Math.max(
        area.minY,
        metricsRef.current.height -
          FAB_SIZE -
          metricsRef.current.bottom -
          DEFAULT_BOTTOM_OFFSET,
      );
      const ratios = storedRatios ?? {
        x: 1,
        y: clamp((defaultY - area.minY) / spanY, 0, 1),
      };
      ratiosRef.current = ratios;
      applyRatios(ratios);
      setReady(true);
    })();
    return () => {
      active = false;
    };
  }, [applyRatios, db]);

  // Keep the button on screen when the window changes (rotation, split view).
  useEffect(() => {
    if (!ready) return;
    const ratios = ratiosRef.current;
    const area = boundsRef.current;
    const spanX = area.maxX - area.minX;
    const spanY = area.maxY - area.minY;
    const point = {
      x: area.minX + clamp(ratios.x, 0, 1) * spanX,
      y: area.minY + clamp(ratios.y, 0, 1) * spanY,
    };
    positionRef.current = point;
    translate.setValue(point);
  }, [bounds, ready, translate]);

  const persist = useCallback(
    async (point: Point) => {
      const area = boundsRef.current;
      const spanX = Math.max(1, area.maxX - area.minX);
      const spanY = Math.max(1, area.maxY - area.minY);
      const ratios = {
        x: clamp((point.x - area.minX) / spanX, 0, 1),
        y: clamp((point.y - area.minY) / spanY, 0, 1),
      };
      ratiosRef.current = ratios;
      await setSetting(
        db,
        POSITION_KEY,
        `${ratios.x.toFixed(3)},${ratios.y.toFixed(3)}`,
      ).catch(() => {});
    },
    [db],
  );

  const open = useCallback(() => router.push("/ask-sua"), [router]);

  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "activate") open();
    },
    [open],
  );

  // Raw responder handlers instead of PanResponder: the React Compiler treats
  // these props as event handlers, so the ref-based drag math is legal, and a
  // press that never moves is still a tap.
  function onResponderGrant(event: GestureResponderEvent) {
    dragRef.current = {
      pageX: event.nativeEvent.pageX,
      pageY: event.nativeEvent.pageY,
      startX: positionRef.current.x,
      startY: positionRef.current.y,
      moved: false,
    };
  }

  function onResponderMove(event: GestureResponderEvent) {
    const drag = dragRef.current;
    const dx = event.nativeEvent.pageX - drag.pageX;
    const dy = event.nativeEvent.pageY - drag.pageY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
    const area = boundsRef.current;
    const next = {
      x: clamp(drag.startX + dx, area.minX, area.maxX),
      y: clamp(drag.startY + dy, area.minY, area.maxY),
    };
    positionRef.current = next;
    translate.setValue(next);
  }

  function settleDrag() {
    if (!dragRef.current.moved) {
      open();
      return;
    }
    void persist(positionRef.current);
  }

  return (
    <Animated.View
      accessible
      accessibilityRole="button"
      accessibilityLabel="Ask Sua assistant. Drag to move, tap to open."
      accessibilityHint="Tap to open Ask Sua, or drag to reposition the button."
      accessibilityActions={[{ name: "activate", label: "Open Ask Sua" }]}
      onAccessibilityAction={onAccessibilityAction}
      onAccessibilityTap={open}
      onStartShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={onResponderGrant}
      onResponderMove={onResponderMove}
      onResponderRelease={settleDrag}
      onResponderTerminate={() => {
        if (dragRef.current.moved) void persist(positionRef.current);
      }}
      className="absolute left-0 top-0 z-50 h-14 w-14 items-center justify-center overflow-hidden rounded-full border-2 border-gold bg-surface shadow-gold"
      style={{
        opacity: ready ? 1 : 0,
        elevation: 12,
        transform: [{ translateX: translate.x }, { translateY: translate.y }],
      }}
    >
      <Image
        source={require("@/assets/images/icons/chatbot-icon.png")}
        className="h-full w-full"
        contentFit="cover"
        style={{width: '100%', height: '100%'}}
        accessibilityLabel="Sua assistant"
      />
    </Animated.View>
  );
}
