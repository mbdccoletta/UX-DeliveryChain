// Whether the selected application is heading somewhere worse.
//
// The chain highlights only what a signal backs — problems, anomalies, custom
// alerts — and the forecast is the fourth signal: the platform's own
// predictive analyzer, run over this application's error series. Fetched
// lazily and memoised per application, because an analyzer execution takes
// seconds and the answer does not change while the user looks at the screen.
import { useEffect, useState } from "react";
import { forecast, type Forecast } from "../utils/forecast";

const memo = new Map<string, Forecast | null>();

export function useAppForecast(appId?: string): Forecast | null {
  const [ahead, setAhead] = useState<Forecast | null>(
    appId ? memo.get(appId) ?? null : null,
  );

  useEffect(() => {
    if (!appId) { setAhead(null); return; }
    if (memo.has(appId)) { setAhead(memo.get(appId) ?? null); return; }
    let live = true;
    setAhead(null);
    forecast(
      `fetch user.events, from: now()-24h
       | filter dt.rum.application.id == "${appId.replace(/"/g, "")}"
       | makeTimeseries errors = countIf(characteristics.classifier == "error"), interval: 1h`,
      12,
    ).then((f) => { memo.set(appId, f); if (live) setAhead(f); });
    return () => { live = false; };
  }, [appId]);

  return ahead;
}
