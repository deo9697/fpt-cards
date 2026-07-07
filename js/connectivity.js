export function watchConnectivity(callback) {
  const notify = () => callback(navigator.onLine);
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
}

export function online() { return navigator.onLine; }
