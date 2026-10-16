import { useEffect, useRef, useState } from "react";
import AdminPageHeader from "./AdminPageHeader";
import { documentationSections } from "./documentationContent";
import type { AppView } from "./navigation";
import "./documentation.css";

type Props = {
  username: string;
  onBack: () => Promise<void>;
  onNavigate: (view: AppView) => Promise<void>;
};

export default function DocumentationPage({ username, onBack, onNavigate }: Props) {
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const mobileContents = useRef<HTMLDetailsElement>(null);
  const section = documentationSections[index];
  useEffect(() => {
    document.body.classList.add("documentation-view");
    return () => document.body.classList.remove("documentation-view");
  }, []);
  function selectSection(next: number) {
    setIndex(next);
    setError("");
    if (mobileContents.current) mobileContents.current.open = false;
    requestAnimationFrame(() => {
      heading.current?.focus({ preventScroll: true });
      heading.current?.scrollIntoView({ block: "start", behavior: "instant" });
    });
  }
  async function navigate(view?: AppView) {
    if (busy) return;
    setBusy(true); setError("");
    try { if (view) await onNavigate(view); else await onBack(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось открыть страницу. Попробуйте ещё раз."); }
    finally { setBusy(false); }
  }
  const contents = (label: string) => <nav aria-label={label}>
    {documentationSections.map((item, i) => <button type="button" key={item.id}
      aria-current={i === index ? "page" : undefined} onClick={() => selectSection(i)}>
      <span className="documentation-number" aria-hidden="true">{i + 1}</span><span>{item.title}</span>
    </button>)}
  </nav>;
  return <div className="documentation-page">
    <AdminPageHeader title="Документация" username={username} busy={busy} onBack={() => void navigate()} />
    <main className="documentation-main">
      <h1>Руководство администратора</h1>
      <div className="documentation-layout">
        <aside className="documentation-sidebar"><h2>Содержание</h2>{contents("Разделы документации")}</aside>
        <div className="documentation-content">
          <details className="documentation-mobile-contents" ref={mobileContents}>
            <summary>Содержание · {index + 1} из {documentationSections.length}</summary>{contents("Разделы документации на телефоне")}
          </details>
          <article className="documentation-article" aria-labelledby="documentation-section-title">
            <h2 id="documentation-section-title" tabIndex={-1} ref={heading}>{index + 1}. {section.title}</h2>
            <p className="documentation-description">{section.description}</p>
            {section.steps.length > 0 && <ol>{section.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>}
            <div className="documentation-example"><h3>Например</h3><p>{section.example}</p></div>
            {section.notes?.map((note, i) => <p className="documentation-note" key={i}>{note}</p>)}
            {section.destination && <button type="button" className="documentation-open" disabled={busy} onClick={() => void navigate(section.destination!.view)}>{section.destination.label}<span aria-hidden="true"> →</span></button>}
          </article>
          {error && <p role="alert" className="documentation-error">{error}</p>}
          <nav className="documentation-pagination" aria-label="Переход между разделами">
            <button type="button" disabled={index === 0} onClick={() => selectSection(index - 1)}>← Предыдущий раздел</button>
            <button type="button" disabled={index === documentationSections.length - 1} onClick={() => selectSection(index + 1)}>Следующий раздел →</button>
          </nav>
        </div>
      </div>
    </main>
  </div>;
}
