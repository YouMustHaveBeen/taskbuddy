import { StrictMode, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { pickLanguage, t, type Language } from "../../i18n";
import { Inbox } from "./Inbox";
import { Today } from "./Today";
import { References } from "./References";
import { Tasks } from "./Tasks";
import { forgetSession, signIn, type PageUser } from "./session";

function App() {
  const [state, setState] = useState<{ user?: PageUser } | undefined>();
  const [tab, setTab] = useState<"now" | "today" | "inbox" | "tasks" | "references">("now");

  useEffect(() => {
    signIn()
      .catch(() => undefined)
      .then((user) => setState({ user }));
  }, []);

  const signedOut = useCallback(() => {
    forgetSession();
    setState({});
  }, []);

  if (!state) return null;
  if (!state.user) return <p>{t(pickLanguage(navigator.language), "web.openFromBot")}</p>;
  const language = state.user.language as Language;
  return (
    <>
      <p>{t(language, "web.signedIn", { name: state.user.name })}</p>
      <nav>
        {(["now", "today", "inbox", "tasks", "references"] as const).map((name) => (
          <button
            key={name}
            type="button"
            aria-current={tab === name ? "page" : undefined}
            onClick={() => setTab(name)}
          >
            {t(language, `tab.${name}`)}
          </button>
        ))}
      </nav>
      {tab === "now" && <Today language={language} onSignedOut={signedOut} ring />}
      {tab === "today" && <Today language={language} onSignedOut={signedOut} ring={false} />}
      {tab === "inbox" && <Inbox language={language} onSignedOut={signedOut} />}
      {tab === "tasks" && <Tasks language={language} onSignedOut={signedOut} />}
      {tab === "references" && <References language={language} onSignedOut={signedOut} />}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
