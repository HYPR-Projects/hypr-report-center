export const gaPageView = (path, token) => {
  if(typeof window.gtag !== "function") return;
  window.gtag("config", "G-GL9LXQVMT4", {
    page_path: path,
    page_title: token ? `Report ${token}` : "Hub",
  });
};

export const gaEvent = (eventName, params = {}) => {
  if(typeof window.gtag !== "function") return;
  window.gtag("event", eventName, params);
};
