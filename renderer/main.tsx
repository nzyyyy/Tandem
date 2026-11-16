import { createRoot } from "react-dom/client";
import { App } from "./app.tsx";
import { AssistantStore, StoreContext } from "./store.tsx";
import "./style.css";
const root = createRoot(document.getElementById("root")!);
window.tandem
  .bootstrap()
  .then((bootstrap) => {
    document.documentElement.dataset.appearance =
      bootstrap.preferences.appearance;
    root.render(
      <StoreContext.Provider value={new AssistantStore(bootstrap)}>
        <App />
      </StoreContext.Provider>,
    );
  })
  .catch(() =>
    root.render(
      <div className="startup-error">
        本地界面载入失败，请退出后重新打开 Tandem。
      </div>,
    ),
  );
