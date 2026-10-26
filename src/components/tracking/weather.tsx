import { Badge } from "@/components/ui/badge";
import { formatDistance } from "@/lib/tracking/display";
import type { WeatherCheckpoint, WeatherHazard } from "@/lib/tracking/types";
import { HAZARD_LABELS } from "@/lib/tracking/weather";

/**
 * The weather along a route, shared by the planner's preview and the session
 * page: a hazard badge, and the strip of forecast points.
 */

const timeFormat = new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });

/** Amber for a warning, red for severe. */
export function HazardBadge({ hazard }: { hazard: WeatherHazard }) {
  return (
    <Badge
      variant={hazard.severity === "SEVERE" ? "destructive" : "outline"}
      className={hazard.severity === "WARNING" ? "text-amber-700 dark:text-amber-400" : undefined}
    >
      {hazard.severity === "SEVERE" ? "Severe · " : ""}
      {HAZARD_LABELS[hazard.kind]}
    </Badge>
  );
}

/** The forecast at each point, nearest first, as a row that scrolls sideways. */
export function WeatherStrip({ checkpoints }: { checkpoints: WeatherCheckpoint[] }) {
  if (checkpoints.length === 0) return null;

  return (
    <ol className="flex gap-2 overflow-x-auto pb-1">
      {checkpoints.map((checkpoint) => (
        <li
          key={`${checkpoint.latitude},${checkpoint.longitude}`}
          className={`flex w-24 shrink-0 flex-col items-center gap-0.5 rounded-lg border p-2 text-center text-xs ${checkpoint.hazards.length > 0 ? "border-amber-500/60 bg-amber-500/5" : ""}`}
        >
          <span className="font-medium tabular-nums">
            {checkpoint.distanceAheadMeters < 1000 ? "Now" : formatDistance(checkpoint.distanceAheadMeters)}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {timeFormat.format(new Date(checkpoint.expectedAt))}
          </span>
          {checkpoint.iconBaseUri && (
            // Google's icon, served from gstatic; next/image would need it configured as a remote host.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`${checkpoint.iconBaseUri}.svg`} alt="" className="size-7" />
          )}
          <span className="line-clamp-2">{checkpoint.condition}</span>
          {checkpoint.temperatureC !== null && (
            <span className="tabular-nums">{Math.round(checkpoint.temperatureC)}°C</span>
          )}
          {!!checkpoint.precipitationPercent && (
            <span className="text-blue-700 tabular-nums dark:text-blue-400">
              {checkpoint.precipitationPercent}% rain
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
