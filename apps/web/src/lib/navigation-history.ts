// Track real history entries without adding sentinel entries or changing router-owned state.
export function guardHistory(
  blocked: (destination: URL) => boolean,
  request: (destination: URL, proceed: () => void) => void,
) {
  const key = '__serverforgeHistoryIndex';
  let originalPush = window.history.pushState;
  let originalReplace = window.history.replaceState;
  let installed = false,
    disposed = false;
  let index: number = history.state?.[key] ?? 0;
  let currentURL = location.href;
  let currentState = history.state;
  let restoring: { index: number; destination: URL; target: number } | null = null;
  const remember = () => {
    currentURL = location.href;
    currentState = history.state;
  };
  const push: History['pushState'] = function (state, unused, url) {
    originalPush.call(history, { ...state, [key]: index + 1 }, unused, url);
    index++;
    remember();
  };
  const replace: History['replaceState'] = function (state, unused, url) {
    originalReplace.call(history, { ...state, [key]: index }, unused, url);
    remember();
  };
  const pop = (event: PopStateEvent) => {
    if (!installed) return;
    let target: number | undefined = event.state?.[key];
    if (restoring) {
      event.stopImmediatePropagation();
      if (target !== restoring.index) {
        if (target !== undefined) history.go(restoring.index - target);
        return;
      }
      const pending = restoring;
      restoring = null;
      remember();
      request(pending.destination, () => history.go(pending.target - index));
      return;
    }
    if (target === undefined) {
      // Native fragment navigation creates a null-state entry. Keep the current
      // document's opaque router state so traversing back to this fragment is safe.
      target = index + 1;
      originalReplace.call(history, { ...currentState, [key]: target }, '', location.href);
    }
    const destination = new URL(location.href);
    if (target !== index && blocked(destination)) {
      event.stopImmediatePropagation();
      restoring = { index, destination, target };
      history.go(index - target);
      return;
    }
    index = target;
    remember();
  };
  const hash = (event: HashChangeEvent) => {
    if (restoring) event.stopImmediatePropagation();
    else if (location.href !== currentURL) remember();
  };
  // Register in a layout effect, before the router's passive-effect listener.
  window.addEventListener('popstate', pop, true);
  window.addEventListener('hashchange', hash, true);
  return {
    start() {
      if (disposed || installed) return;
      originalPush = history.pushState;
      originalReplace = history.replaceState;
      index = history.state?.[key] ?? 0;
      history.pushState = push;
      history.replaceState = replace;
      installed = true;
      replace.call(history, history.state, '');
    },
    stop() {
      disposed = true;
      window.removeEventListener('popstate', pop, true);
      window.removeEventListener('hashchange', hash, true);
      if (history.pushState === push) history.pushState = originalPush;
      if (history.replaceState === replace) history.replaceState = originalReplace;
    },
  };
}
