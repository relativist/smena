import SchoolName, { useSchoolSettings } from "./SchoolSettings";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import App from "./App";
import CatalogPage from "./CatalogPage";
import CurriculaPage from "./CurriculaPage";
import PlanCoveragePage from "./PlanCoveragePage";
import CalendarPage from "./CalendarPage";
import BellSchedulePage from "./BellSchedulePage";
import DisplaySettingsPage from "./DisplaySettingsPage";
import TeacherLoadPage from "./TeacherLoadPage";
import TeacherReassignmentsPage, { type TeacherReassignmentsContext } from "./TeacherReassignmentsPage";
import SchedulePrintPage from "./SchedulePrintPage";
import DocumentationPage from "./DocumentationPage";
import { pathForView, viewForPath, type AppView } from "./navigation";
import { withBasePath } from "./basePath";
import { api, ApiError, type AuthSession, type AuthStatus } from "./api";
import type { StateResponse } from "../server/contracts";
import "./auth.css";
import "./styles.css";
import "./subject-colors.css";

type Screen =
  | "checking"
  | "setup"
  | "login"
  | "loading-state"
  | "editor"
  | "error";

function messageOf(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Не удалось выполнить запрос. Попробуйте ещё раз.";
}

export default function AuthShell() {
  const { update: updateSchoolSettings } = useSchoolSettings();
  const [view, setView] = useState<AppView>(() => viewForPath(window.location.pathname) ?? "schedule");
  const viewRef = useRef<AppView>(view);
  viewRef.current = view;
  const historyIndexRef = useRef(
    typeof window.history.state?.smenaIndex === "number" ? window.history.state.smenaIndex : 0,
  );
  const [planContext, setPlanContext] = useState<{
    groupId?: string;
    quarterId?: string;
  }>({});
  const [reassignmentContext, setReassignmentContext] = useState<TeacherReassignmentsContext | undefined>();
  // A catalog shortcut applies to one visit; returning through history must
  // open the ordinary page instead of starting the old absence preview again.
  useEffect(() => {
    if (view !== "teacher-replacements") setReassignmentContext(undefined);
  }, [view]);
  const [printDate, setPrintDate] = useState<string>();
  const [screen, setScreen] = useState<Screen>("checking");
  const [auth, setAuth] = useState<AuthSession | null>(null);
  const [state, setState] = useState<StateResponse | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const [reauth, setReauth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const passwordRef = useRef<HTMLInputElement>(null);

  const loadState = useCallback(
    async (nextAuth: AuthSession, keepEditor = false, targetView = viewRef.current, quarterId?: string) => {
      setError("");
      if (!keepEditor) setScreen("loading-state");
      try {
        const domainViews = ["catalog", "plans", "calendar", "bells"];
        const path = domainViews.includes(targetView)
          ? `/api/admin/state?view=${targetView}${quarterId ? `&quarterId=${encodeURIComponent(quarterId)}` : ""}` : targetView === "schedule"
            ? "/api/editor/bootstrap" : "/api/admin/state?view=bootstrap";
        const next = await api<StateResponse>(path);
        if (next.displaySettings) updateSchoolSettings({ schoolName: next.displaySettings.settings.schoolName ?? "", studentSubjectIcons: next.displaySettings.settings.studentSubjectIcons });
        setAuth(nextAuth);
        setState(next);
        setVersion((current) => current + 1);
        setScreen("editor");
        setReauth(false);
      } catch (reason) {
        if (reason instanceof ApiError && reason.status === 401 && keepEditor) {
          setReauth(true);
          setError("Сеанс завершился. Войдите снова, чтобы продолжить работу.");
          throw reason;
        }
        setError(messageOf(reason));
        if (!keepEditor) setScreen("error");
        else throw reason;
      }
    },
    [updateSchoolSettings],
  );

  const checkSession = useCallback(async () => {
    setError("");
    setScreen("checking");
    try {
      const status = await api<AuthStatus>("/api/auth/status");
      if (status.authenticated && status.username && status.csrfToken) {
        const session = {
          username: status.username,
          csrfToken: status.csrfToken,
        };
        setAuth(session);
        setUsername(session.username);
        await loadState(session);
      } else {
        setScreen(status.needsSetup ? "setup" : "login");
      }
    } catch (reason) {
      setError(messageOf(reason));
      setScreen("error");
    }
  }, [loadState]);

  useEffect(() => {
    window.history.replaceState({ smenaView: view, smenaIndex: historyIndexRef.current }, "", pathForView(view));
  }, []);

  useEffect(() => {
    const restorePreviousEntry = (targetIndex: number) => {
      const distance = historyIndexRef.current - targetIndex;
      if (Number.isFinite(distance) && distance !== 0) window.history.go(distance);
      else window.history.replaceState({ smenaView: viewRef.current, smenaIndex: historyIndexRef.current }, "", pathForView(viewRef.current));
    };
    const onPopState = (event: PopStateEvent) => {
      const requested = viewForPath(window.location.pathname);
      if (!requested) {
        window.history.replaceState({ smenaView: viewRef.current, smenaIndex: historyIndexRef.current }, "", pathForView(viewRef.current));
        return;
      }
      const targetIndex = typeof event.state?.smenaIndex === "number" ? event.state.smenaIndex : historyIndexRef.current;
      const current = viewRef.current;
      if (requested === current) {
        historyIndexRef.current = targetIndex;
        return;
      }
      const pendingEdits = screen === "editor" && window.dispatchEvent(new Event("beforeunload", { cancelable: true })) === false;
      if (pendingEdits && !window.confirm("Покинуть страницу? Несохранённые изменения могут быть потеряны.")) {
        restorePreviousEntry(targetIndex);
        return;
      }
      const finishNavigation = () => {
        historyIndexRef.current = targetIndex;
        setView(requested);
      };
      if (!auth || screen !== "editor") {
        finishNavigation();
        return;
      }
      void loadState(auth, true, requested).then(finishNavigation).catch(() => restorePreviousEntry(targetIndex));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [auth, loadState, screen]);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  async function submitCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const setup = screen === "setup";
    if (setup && password !== confirmPassword) {
      setError("Пароли не совпадают.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api<AuthStatus>(
        setup ? "/api/auth/setup" : "/api/auth/login",
        {
          method: "POST",
          body: JSON.stringify({ username: username.trim(), password }),
        },
      );
      if (!result.authenticated || !result.username || !result.csrfToken) {
        throw new Error("Сервер не подтвердил вход. Попробуйте ещё раз.");
      }
      const nextAuth = {
        username: result.username,
        csrfToken: result.csrfToken,
      };
      setPassword("");
      setConfirmPassword("");
      if (reauth) {
        // Keep the editor mounted so any unsaved work survives session renewal.
        setAuth(nextAuth);
        setReauth(false);
        setError("");
      } else {
        await loadState(nextAuth);
      }
    } catch (reason) {
      setError(messageOf(reason));
      passwordRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const onUnauthorized = useCallback(() => {
    setReauth(true);
    setError("Сеанс завершился. Войдите снова, чтобы продолжить работу.");
    setPassword("");
    setConfirmPassword("");
  }, []);

  const onLogout = useCallback(async () => {
    if (!auth) return;
    await api<{ ok: boolean }>("/api/auth/logout", {
      method: "POST",
      headers: { "x-csrf-token": auth.csrfToken },
    });
    setState(null);
    setAuth(null);
    setReauth(false);
    setError("");
    setPassword("");
    setView("schedule");
    window.history.replaceState({ smenaView: "schedule", smenaIndex: historyIndexRef.current }, "", pathForView("schedule"));
    setScreen("login");
  }, [auth]);

  const onReload = useCallback(async () => {
    if (auth) await loadState(auth, true);
  }, [auth, loadState]);

  async function navigate(next: AppView, historyMode: "push" | "replace" = "push", quarterId?: string) {
    if (!auth) return;
    await loadState(auth, true, next, quarterId);
    if (historyMode === "replace") window.history.replaceState({ smenaView: next, smenaIndex: historyIndexRef.current }, "", pathForView(next));
    else if (viewRef.current !== next) {
      historyIndexRef.current += 1;
      window.history.pushState({ smenaView: next, smenaIndex: historyIndexRef.current }, "", pathForView(next));
    }
    setView(next);
  }

  if (screen === "editor" && state && auth) {
    return (
      <>
        <div aria-hidden={reauth || undefined} inert={reauth || undefined}>
          {view === "documentation" ? (
            <DocumentationPage username={auth.username}
              onBack={() => navigate("schedule", "replace")}
              onNavigate={next => navigate(next)} />
          ) : view === "catalog" ? (
            <CatalogPage
              initialState={state}
              auth={auth}
              onUnauthorized={onUnauthorized}
              onBack={() => navigate("schedule", "replace")}
              onOpenReassignments={async context => {
                setReassignmentContext(context);
                await navigate("teacher-replacements");
              }}
            />
          ) : view === "bells" ? (
            <BellSchedulePage initialState={state} auth={auth}
              initialGroupId={planContext.groupId} initialQuarterId={planContext.quarterId}
              onUnauthorized={onUnauthorized} onBack={() => navigate("schedule", "replace")} />
          ) : view === "display-settings" ? (
            <DisplaySettingsPage auth={auth} onUnauthorized={onUnauthorized}
              onBack={() => navigate("schedule", "replace")} />
          ) : view === "calendar" ? (
            <CalendarPage initialState={state} auth={auth}
              onUnauthorized={onUnauthorized} onBack={() => navigate("schedule", "replace")} />
          ) : view === "teacher-load" ? (
            <TeacherLoadPage initialState={state} auth={auth}
              initialQuarterId={planContext.quarterId}
              onUnauthorized={onUnauthorized} onBack={() => navigate("schedule", "replace")} />
          ) : view === "teacher-replacements" ? (
            <TeacherReassignmentsPage initialState={state} auth={auth}
              initialQuarterId={planContext.quarterId} initialContext={reassignmentContext}
              onUnauthorized={onUnauthorized} onBack={() => navigate("schedule", "replace")} />
          ) : view === "schedule-print" ? (
            <SchedulePrintPage initialState={state} auth={auth}
              initialGroupId={planContext.groupId} initialQuarterId={planContext.quarterId} initialDate={printDate}
              onUnauthorized={onUnauthorized} onBack={() => navigate("schedule", "replace")} />
          ) : view === "plan-coverage" ? (
            <PlanCoveragePage initialState={state} auth={auth}
              initialQuarterId={planContext.quarterId}
              onUnauthorized={onUnauthorized}
              onBack={async (groupId, quarterId) => {
                setPlanContext(current => ({ groupId: groupId ?? current.groupId, quarterId: quarterId ?? current.quarterId }));
                await navigate("schedule", "replace");
              }} />
          ) : view === "plans" ? (
            <CurriculaPage initialState={state} auth={auth} onUnauthorized={onUnauthorized}
              initialGroupId={planContext.groupId} initialQuarterId={planContext.quarterId}
              onBack={async (groupId, quarterId) => {
                setPlanContext({ groupId, quarterId }); await navigate("schedule", "replace");
              }}
              />
          ) : (
            <App
              key={version}
              initialState={state}
              auth={auth}
              onUnauthorized={onUnauthorized}
              onLogout={onLogout}
              onReload={onReload}
              onOpenCatalog={async (groupId, quarterId) => {
                setPlanContext({ groupId, quarterId });
                await navigate("catalog");
              }}
              initialGroupId={planContext.groupId}
              initialQuarterId={planContext.quarterId}
              onOpenCalendar={async (groupId, quarterId) => {
                setPlanContext({ groupId, quarterId });
                await navigate("calendar");
              }}
              onOpenBells={async (groupId, quarterId) => {
                setPlanContext({ groupId, quarterId });
                await navigate("bells");
              }}
              onOpenDisplaySettings={async (groupId, quarterId) => {
                setPlanContext({ groupId, quarterId });
                await navigate("display-settings");
              }}
              onOpenDocumentation={async (groupId, quarterId) => {
                setPlanContext({ groupId, quarterId });
                await navigate("documentation");
              }}
              onOpenPlan={async (groupId, quarterId) => {
                setPlanContext({ groupId, quarterId });
                await navigate("plans", "push", quarterId);
              }}
              onOpenPlanCoverage={async (groupId, quarterId) => {
                setPlanContext({ groupId, quarterId });
                await navigate("plan-coverage");
              }}
              onOpenTeacherLoad={async (groupId, quarterId) => {
                setPlanContext({ groupId, quarterId });
                await navigate("teacher-load");
              }}
              onOpenReassignments={async (groupId, quarterId) => {
                setPlanContext({ groupId, quarterId });
                setReassignmentContext(undefined);
                await navigate("teacher-replacements");
              }}
              onOpenPrint={async (groupId, quarterId, date) => {
                setPlanContext({ groupId, quarterId });
                setPrintDate(date);
                await navigate("schedule-print");
              }}
            />
          )}
        </div>
        {reauth && (
          <AuthForm
            setup={false}
            modal
            authBusy={busy}
            error={error}
            username={username}
            password={password}
            confirmPassword={confirmPassword}
            setUsername={setUsername}
            setPassword={setPassword}
            setConfirmPassword={setConfirmPassword}
            passwordRef={passwordRef}
            submit={submitCredentials}
          />
        )}
      </>
    );
  }

  if (screen === "checking" || screen === "loading-state") {
    return (
      <main className="auth-page">
        <div className="auth-card" role="status">
          {screen === "checking" ? "Проверяем сеанс…" : "Загружаем расписание…"}
        </div>
      </main>
    );
  }
  if (screen === "error") {
    return (
      <main className="auth-page">
        <section className="auth-card" aria-labelledby="auth-title">
          <Brand />
          <h1 id="auth-title">Не удалось подключиться</h1>
          <p className="auth-error" role="alert">
            {error}
          </p>
          <button className="auth-primary" onClick={() => void checkSession()}>
            Повторить
          </button>
        </section>
      </main>
    );
  }
  return (
    <AuthForm
      setup={screen === "setup"}
      authBusy={busy}
      error={error}
      username={username}
      password={password}
      confirmPassword={confirmPassword}
      setUsername={setUsername}
      setPassword={setPassword}
      setConfirmPassword={setConfirmPassword}
      passwordRef={passwordRef}
      submit={submitCredentials}
    />
  );
}

function Brand() {
  return (
    <>
      <div className="auth-brand">
        <img className="auth-mascot" src={withBasePath("/schoolboy.png")} alt="" width="80" height="80" decoding="async" />
        <span className="auth-brand-name">Смена</span>
      </div>
      <SchoolName className="auth-school-name" />
    </>
  );
}

type AuthFormProps = {
  setup: boolean;
  modal?: boolean;
  authBusy: boolean;
  error: string;
  username: string;
  password: string;
  confirmPassword: string;
  setUsername: (value: string) => void;
  setPassword: (value: string) => void;
  setConfirmPassword: (value: string) => void;
  passwordRef: React.RefObject<HTMLInputElement | null>;
  submit: (event: FormEvent<HTMLFormElement>) => void;
};

function AuthForm(props: AuthFormProps) {
  const {
    setup,
    modal = false,
    authBusy,
    error,
    username,
    password,
    confirmPassword,
    setUsername,
    setPassword,
    setConfirmPassword,
    passwordRef,
    submit,
  } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!modal || !dialogRef.current) return;
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => dialog.close();
  }, [modal]);
  const card = (
    <section
      className="auth-card"
      aria-labelledby={modal ? "reauth-title" : "auth-title"}
    >
      <Brand />
      <h1 id={modal ? "reauth-title" : "auth-title"}>
        {setup ? "Создать администратора" : "Вход в расписание"}
      </h1>
      {setup && <p className="auth-subtitle">Создайте учётную запись администратора школы.</p>}
      <form onSubmit={submit}>
        <label htmlFor={modal ? "reauth-username" : "auth-username"}>
          Логин
        </label>
        <input
          id={modal ? "reauth-username" : "auth-username"}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoFocus={modal}
          required
          maxLength={64}
          disabled={authBusy}
        />
        <label htmlFor={modal ? "reauth-password" : "auth-password"}>
          Пароль
        </label>
        <input
          ref={passwordRef}
          id={modal ? "reauth-password" : "auth-password"}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete={setup ? "new-password" : "current-password"}
          required
          minLength={setup ? 8 : undefined}
          maxLength={128}
          disabled={authBusy}
        />
        {setup && (
          <>
            <label htmlFor="auth-confirm-password">Повторите пароль</label>
            <input
              id="auth-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={128}
              disabled={authBusy}
            />
          </>
        )}
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        <button className="auth-primary" type="submit" disabled={authBusy}>
          {authBusy ? "Подождите…" : setup ? "Создать администратора" : "Войти"}
        </button>
      </form>
    </section>
  );
  if (modal)
    return (
      <dialog
        ref={dialogRef}
        className="auth-overlay"
        aria-labelledby="reauth-title"
        onCancel={(event) => event.preventDefault()}
      >
        {card}
      </dialog>
    );
  return <main className="auth-page">{card}</main>;
}
