import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

interface AccountHoverDetailsProps {
  readonly noteText: string;
  readonly ageText: string;
  readonly children: ReactNode;
}

interface Coordinates {
  readonly x: number;
  readonly y: number;
}

const HOVER_DELAY_MS = 1000;
const VIEWPORT_MARGIN_PX = 8;
const POINTER_GAP_PX = 12;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function AccountHoverDetails({
  noteText,
  ageText,
  children,
}: AccountHoverDetailsProps) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<Coordinates | null>(null);
  const [placement, setPlacement] = useState<CSSProperties | null>(null);
  const [constrained, setConstrained] = useState(false);
  const [viewportRevision, setViewportRevision] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerRef = useRef<Coordinates>({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const naturalHeightRef = useRef(0);
  const tooltipId = useId();

  const handleMouseEnter = (event: MouseEvent<HTMLDivElement>) => {
    pointerRef.current = { x: event.clientX, y: event.clientY };
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setCoords(pointerRef.current);
      setVisible(true);
    }, HOVER_DELAY_MS);
  };

  const handleMouseLeave = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
    setPlacement(null);
    setConstrained(false);
  };

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>) => {
    const nextCoords = { x: event.clientX, y: event.clientY };
    pointerRef.current = nextCoords;
    if (visible) {
      setCoords(nextCoords);
    }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!visible) {
      return;
    }

    const handleViewportChange = () => {
      setViewportRevision((revision) => revision + 1);
    };
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || !coords || !containerRef.current || !tooltipRef.current) {
      return;
    }

    const containerRect = containerRef.current.getBoundingClientRect();
    const rect = tooltipRef.current.getBoundingClientRect();
    const maxLeft = Math.max(VIEWPORT_MARGIN_PX, window.innerWidth - rect.width - VIEWPORT_MARGIN_PX);
    const fitsRight = coords.x + POINTER_GAP_PX + rect.width <= window.innerWidth - VIEWPORT_MARGIN_PX;
    const belowCard = containerRect.bottom + POINTER_GAP_PX;
    const availableBelow = Math.max(0, window.innerHeight - VIEWPORT_MARGIN_PX - belowCard);
    const availableAbove = Math.max(0, containerRect.top - POINTER_GAP_PX - VIEWPORT_MARGIN_PX);
    const measuredHeight = tooltipRef.current.scrollHeight + 2;
    if (!constrained) {
      naturalHeightRef.current = Math.max(naturalHeightRef.current, measuredHeight);
    }
    const naturalHeight = Math.min(
      Math.max(naturalHeightRef.current, measuredHeight),
      window.innerHeight - VIEWPORT_MARGIN_PX * 2,
    );
    const fitsBelow = naturalHeight <= availableBelow;
    const fitsAbove = naturalHeight <= availableAbove;
    const placeBelow = fitsBelow || (!fitsAbove && availableBelow >= availableAbove);
    const availableHeight = placeBelow ? availableBelow : availableAbove;
    const renderedHeight = Math.min(naturalHeight, availableHeight);
    setConstrained(availableHeight < naturalHeight);
    const maxTop = Math.max(VIEWPORT_MARGIN_PX, window.innerHeight - renderedHeight - VIEWPORT_MARGIN_PX);
    const preferredLeft = fitsRight
      ? coords.x + POINTER_GAP_PX
      : coords.x - rect.width - POINTER_GAP_PX;
    const preferredTop = placeBelow
      ? belowCard
      : containerRect.top - POINTER_GAP_PX - renderedHeight;

    setPlacement({
      position: 'fixed',
      left: clamp(preferredLeft, VIEWPORT_MARGIN_PX, maxLeft),
      top: clamp(preferredTop, VIEWPORT_MARGIN_PX, maxTop),
      maxHeight: availableHeight,
      overflow: 'hidden',
      pointerEvents: 'none',
      zIndex: 9999,
    });
  }, [visible, coords, viewportRevision, constrained]);

  return (
    <div
      ref={containerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseMove={handleMouseMove}
      aria-describedby={visible ? tooltipId : undefined}
      className="w-full"
    >
      {children}
      {visible && createPortal(
        <div
          id={tooltipId}
          ref={tooltipRef}
          role="tooltip"
          data-testid="account-hover-details"
          style={placement ?? {
            position: 'fixed',
            left: VIEWPORT_MARGIN_PX,
            top: VIEWPORT_MARGIN_PX,
            visibility: 'hidden',
            pointerEvents: 'none',
          }}
          className={`bg-slate-950/95 backdrop-blur-md border border-slate-800 rounded-xl shadow-xl max-h-[calc(100vh-16px)] text-left select-none text-slate-100 pointer-events-none flex flex-col ${
            constrained
              ? 'w-[calc(100vw-16px)] p-1.5 gap-1'
              : 'w-[min(240px,calc(100vw-16px))] p-3 gap-2.5'
          }`}
        >
          <div className="min-h-0 flex-1 flex flex-col">
            <span className={`block font-semibold text-slate-400 uppercase tracking-wider ${
              constrained ? 'text-[8px]' : 'text-[10px] mb-1'
            }`}>
              备注
            </span>
            <div className={`min-h-0 max-h-[120px] overflow-y-auto break-words whitespace-pre-wrap text-slate-200 ${
              constrained ? 'text-[10px] leading-3.5' : 'text-xs leading-relaxed'
            }`}>
              {noteText}
            </div>
          </div>
          <div className={`shrink-0 border-t border-slate-800/80 flex items-center justify-between ${
            constrained ? 'pt-1' : 'pt-2'
          }`}>
            <span className={`${constrained ? 'text-[8px]' : 'text-[10px]'} font-semibold text-slate-400 uppercase tracking-wider`}>
              创建至今
            </span>
            <span className={`${constrained ? 'text-[10px]' : 'text-xs'} font-bold font-mono text-cyan-400`}>
              {ageText}
            </span>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
