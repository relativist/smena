import "./admin-page-header.css";
import SchoolName from "./SchoolSettings";

type Props = {
  title: string;
  onBack: () => void;
  disabled?: boolean;
  busy?: boolean;
  username?: string;
};

export default function AdminPageHeader({ title, onBack, disabled, busy, username }: Props) {
  return <header className="admin-page-header">
    <button type="button" className="admin-page-back" onClick={onBack} disabled={disabled || busy} aria-label="Назад в расписание">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7M8 12h13" /></svg>
      <span>{busy ? "Возврат…" : "К расписанию"}</span>
    </button>
    <div className="admin-page-identity">
      <span className="admin-page-mark" aria-label="Смена">С</span>
      <span className="admin-page-heading"><span className="admin-page-title">{title}</span><SchoolName className="admin-page-school-name" /></span>
    </div>
    {username && <span className="admin-page-user">{username}</span>}
  </header>;
}
