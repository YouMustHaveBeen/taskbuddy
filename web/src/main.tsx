import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { pickLanguage, t, type Language } from "../../i18n";
import { References } from "./References";
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
  const language = state.user.language as Language;
  return (
    <>
      <p>{t(language, "web.signedIn", { name: state.user.name })}</p>
      <nav>
        <button type="button" aria-current="page">
          {t(language, "tab.references")}
        </button>
      </nav>
      <References language={language} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
