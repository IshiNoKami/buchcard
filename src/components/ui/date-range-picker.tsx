import { useState, useRef, useEffect, useMemo } from "react";
import { ChevronLeft, ChevronRight, CalendarRange, X } from "lucide-react";

export interface DateRange {
  from: string;
  to: string;
}

interface Props {
  value: DateRange | null;
  activeDates?: Set<string>;
  onChange: (range: DateRange | null) => void;
}

const DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MONTHS_FULL = [
  "Январь","Февраль","Март","Апрель","Май","Июнь",
  "Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь",
];
const MONTHS_SHORT = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];

function toIso(y: number, m: number, d: number) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function fmtDate(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}
function todayIso() {
  const n = new Date();
  return toIso(n.getFullYear(), n.getMonth(), n.getDate());
}

export function DateRangePicker({ value, activeDates = new Set(), onChange }: Props) {
  const today = todayIso();
  const [open, setOpen]         = useState(false);
  const [viewYear, setViewYear] = useState(() => new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(() => new Date().getMonth());
  const [anchor, setAnchor]     = useState<string | null>(null); // first click
  const [hover, setHover]       = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Navigate to selection on open
  useEffect(() => {
    if (open) {
      const src = value?.from ?? today;
      const d = new Date(src + "T00:00:00");
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
      setAnchor(null);
      setHover(null);
    }
  }, [open]); // eslint-disable-line

  // Close on outside click
  useEffect(() => {
    function h(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setAnchor(null);
      }
    }
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Cells for current month (Mon-first, padded)
  const cells = useMemo(() => {
    const first = new Date(viewYear, viewMonth, 1);
    const days  = new Date(viewYear, viewMonth + 1, 0).getDate();
    const offset = (first.getDay() + 6) % 7;
    const result: (string | null)[] = Array(offset).fill(null);
    for (let d = 1; d <= days; d++) result.push(toIso(viewYear, viewMonth, d));
    while (result.length % 7 !== 0) result.push(null);
    return result;
  }, [viewYear, viewMonth]);

  // Effective range while selecting (anchor + hover preview)
  const effFrom = anchor
    ? (hover && hover < anchor ? hover : anchor)
    : (value?.from ?? null);
  const effTo = anchor
    ? (hover && hover > anchor ? hover : anchor)
    : (value?.to ?? null);

  function onDayClick(date: string) {
    if (!anchor) {
      setAnchor(date);
    } else {
      const [from, to] = date >= anchor ? [anchor, date] : [date, anchor];
      onChange({ from, to });
      setAnchor(null);
      setHover(null);
      setOpen(false);
    }
  }

  function prevMonth() {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  }
  function clear() { onChange(null); setAnchor(null); setOpen(false); }

  // Styling helpers
  function outerCls(date: string): string {
    const inRange = !!(effFrom && effTo && date > effFrom && date < effTo);
    const isEdge  = date === effFrom || date === effTo;
    if (!inRange && !isEdge) return "flex items-center justify-center py-0.5";
    const col = "flex items-center justify-center py-0.5 bg-primary/15";
    const left  = date === effFrom && effTo && effFrom !== effTo ? " rounded-l-md" : "";
    const right = date === effTo   && effFrom && effFrom !== effTo ? " rounded-r-md" : "";
    if (isEdge && !inRange) return col + left + right; // single selection
    return col + left + right;
  }

  function innerCls(date: string): string {
    const isStart  = date === effFrom;
    const isEnd    = date === effTo;
    const hasData  = activeDates.has(date);
    const isToday  = date === today;
    const inRange  = !!(effFrom && effTo && date > effFrom && date < effTo);

    let cls = "h-8 w-8 flex items-center justify-center text-xs rounded-md transition-colors cursor-pointer select-none relative ";

    if (isStart || isEnd) {
      cls += "bg-primary text-primary-foreground font-semibold shadow-sm";
    } else if (inRange) {
      cls += hasData
        ? "bg-primary/25 text-foreground font-medium"
        : "text-foreground/80";
    } else if (hasData) {
      cls += "bg-muted text-foreground font-medium hover:bg-primary/25";
    } else if (isToday) {
      cls += "ring-1 ring-primary/50 text-primary hover:bg-accent";
    } else {
      cls += "text-muted-foreground hover:bg-accent";
    }

    return cls;
  }

  const triggerLabel = value
    ? `${fmtDate(value.from)} — ${fmtDate(value.to)}`
    : "Свой период";
  const active = !!value;

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      <button
        onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs border transition-colors ${
          active
            ? "bg-primary text-primary-foreground border-primary"
            : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
        }`}
      >
        <CalendarRange className="h-3 w-3 shrink-0" />
        <span>{triggerLabel}</span>
        {active && (
          <span onClick={e => { e.stopPropagation(); clear(); }}>
            <X className="h-2.5 w-2.5 ml-0.5" />
          </span>
        )}
      </button>

      {/* Calendar popover */}
      {open && (
        <div className="absolute top-full left-0 mt-2 z-50 bg-card border border-border rounded-2xl shadow-2xl p-4 w-[280px]">

          {/* Month navigation */}
          <div className="flex items-center justify-between mb-3">
            <button
              onClick={prevMonth}
              className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold">
              {MONTHS_FULL[viewMonth]} {viewYear}
            </span>
            <button
              onClick={nextMonth}
              className="h-7 w-7 flex items-center justify-center rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 mb-1">
            {DAYS.map(d => (
              <div key={d} className="h-6 flex items-center justify-center text-[10px] font-medium text-muted-foreground">
                {d}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7">
            {cells.map((date, i) =>
              date ? (
                <div
                  key={i}
                  className={outerCls(date)}
                  onClick={() => onDayClick(date)}
                  onMouseEnter={() => anchor && setHover(date)}
                  onMouseLeave={() => anchor && setHover(null)}
                >
                  <div className={innerCls(date)}>
                    {parseInt(date.split("-")[2], 10)}
                  </div>
                </div>
              ) : (
                <div key={i} className="h-9" />
              )
            )}
          </div>

          {/* Footer */}
          <div className="mt-3 pt-3 border-t border-border flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <span className="inline-block h-3 w-3 rounded-sm bg-muted border border-border/50" />
              есть данные
            </div>
            <div className="text-[10px]">
              {anchor ? (
                <span className="text-primary">выберите конечную дату</span>
              ) : value ? (
                <button onClick={clear} className="text-muted-foreground hover:text-foreground transition-colors">
                  сбросить
                </button>
              ) : (
                <span className="text-muted-foreground">нажмите на день</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
