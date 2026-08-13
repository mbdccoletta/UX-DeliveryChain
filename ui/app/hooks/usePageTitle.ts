// The app shell composes "<page> - <app> - <tenant> - Dynatrace" in the tab,
// so a page only has to name itself. Without this every tab of the app looks
// identical once a few are open.
import { useEffect } from "react";

export function usePageTitle(title: string | undefined): void {
  useEffect(() => {
    if (title !== undefined) document.title = title;
  }, [title]);
}
