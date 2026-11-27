import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { pickLanguage, t, type Language } from "../../i18n";
import { signIn, type PageUser } from "./session";

function App() {
  const [state, setState] = useState<{ user?: PageUser } | undefined>();

  useEffect(() => {
    signIn()
      .catch(() => undefined)
      .then((user) => setState({ user }));
  }, []);

  if (!state) return null;
  if (!state.user) return <p>{t(pickLanguage(navigator.language), "web.openFromBot")}</p>;
  return <p>{t(state.user.language as Language, "web.signedIn", { name: state.user.name })}</p>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
