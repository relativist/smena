import { resolveSubjectIconId, type SubjectIconSubject } from "../shared/subjectIcons.ts";
import "./subject-icons.css";

type Props = { subject: SubjectIconSubject; className?: string };

export default function SubjectIcon({ subject, className = "" }: Props) {
  const icon = resolveSubjectIconId(subject);
  if (!icon) return null;
  const cls = `subject-icon subject-icon--${icon}${className ? ` ${className}` : ""}`;
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

  let drawing;
  switch (icon) {
    case "flag-uk": drawing = <><path fill="#315a9d" d="M3 5h18v14H3z"/><path fill="#fff" d="m3 5 2.2 0L21 17.2V19h-2.2L3 6.8zm18 0h-2.2L3 17.2V19h2.2L21 6.8z"/><path fill="#c8394b" d="m3 5 1 0L21 18v1L20 19 3 6zM21 5h-1L3 18v1h1L21 6z"/><path fill="#fff" d="M10 5h4v14h-4zM3 10h18v4H3z"/><path fill="#c8394b" d="M10.8 5h2.4v14h-2.4zM3 10.8h18v2.4H3z"/></>;
      break;
    case "flag-de": drawing = <><path fill="#2c3139" d="M3 5h18v4.7H3z"/><path fill="#c94245" d="M3 9.7h18v4.6H3z"/><path fill="#f3c34f" d="M3 14.3h18V19H3z"/></>;
      break;
    case "flag-fr": drawing = <><path fill="#355fa5" d="M3 5h6v14H3z"/><path fill="#fff" d="M9 5h6v14H9z"/><path fill="#e65055" d="M15 5h6v14h-6z"/></>;
      break;
    case "flag-cn": drawing = <><path fill="#d74643" d="M3 5h18v14H3z"/><path fill="#f6ca55" d="m7 7 .45 1.25 1.35.04-1.08.82.39 1.3L7 9.66l-1.11.75.39-1.3-1.08-.82 1.35-.04zM11 7l.2.55.58.02-.47.36.17.56-.48-.32-.48.32.17-.56-.47-.36.59-.02zM13 9l.2.55.58.02-.47.36.17.56-.48-.32-.48.32.17-.56-.47-.36.59-.02zM13 12l.2.55.58.02-.47.36.17.56-.48-.32-.48.32.17-.56-.47-.36.59-.02zM11 14l.2.55.58.02-.47.36.17.56-.48-.32-.48.32.17-.56-.47-.36.59-.02z"/></>;
      break;
    case "book": drawing = <><path {...common} fill="#edf2ff" d="M4.5 6.5c2.8-.8 5.1-.2 7.5 1.2v11c-2.4-1.4-4.7-2-7.5-1.2z"/><path {...common} fill="#dce9ff" d="M19.5 6.5c-2.8-.8-5.1-.2-7.5 1.2v11c2.4-1.4 4.7-2 7.5-1.2z"/><path {...common} d="M12 8v11M6.5 9.5c1.3-.1 2.5.1 3.5.7m-3.5 2c1.3-.1 2.5.1 3.5.7m7.5-3.4c-1.3-.1-2.5.1-3.5.7m3.5 2c-1.3-.1-2.5.1-3.5.7"/></>;
      break;
    default: drawing = glyph(icon, common);
  }

  return <svg className={cls} viewBox="0 0 24 24" aria-hidden="true" focusable="false">{drawing}</svg>;
}

function glyph(icon: Exclude<ReturnType<typeof resolveSubjectIconId>, null | "flag-uk" | "flag-de" | "flag-fr" | "flag-cn" | "book">, s: { stroke: string; strokeWidth: number; strokeLinecap: "round"; strokeLinejoin: "round" }) {
  switch (icon) {
    case "russian": return <><path fill="#fff" d="M3 5h18v4.7H3z"/><path fill="#3563b4" d="M3 9.7h18v4.6H3z"/><path fill="#d64a4a" d="M3 14.3h18V19H3z"/><path fill="none" stroke="#aab4c5" strokeWidth=".5" d="M3 5h18v14H3z"/></>;
    case "literature": return <><path {...s} fill="#fff0d8" d="M4.5 6c2.7-.8 5.1-.2 7.5 1.2v11c-2.4-1.4-4.8-2-7.5-1.2z"/><path {...s} fill="#ffe2c0" d="M19.5 6c-2.7-.8-5.1-.2-7.5 1.2v11c2.4-1.4 4.8-2 7.5-1.2z"/><path {...s} d="M12 7.2v11m-5-8c1.2-.1 2.4.1 3.4.7m6.6-.7c-1.2-.1-2.4.1-3.4.7"/><path fill="#d18b47" d="M10.5 4h3v2h-3z"/></>;
    case "reading": return <><path {...s} fill="#fff3df" d="M5 5.5h14v14H5z"/><path {...s} fill="#fff" d="M7.5 8h6v9h-6z"/><path {...s} fill="#d18b47" d="M14 7h3v11l-1.5-1.5L14 18z"/><path {...s} d="M8.5 10h4m-4 2h4m-4 2h2"/></>;
    case "math": return <><path {...s} stroke="#4775ce" strokeWidth="2.1" d="M4 7h6M7 4v6"/><path {...s} stroke="#896dbd" strokeWidth="2.1" d="M14 7h6"/><path {...s} stroke="#40948b" strokeWidth="2.1" d="m4.8 14.8 4.4 4.4m0-4.4-4.4 4.4"/><path {...s} stroke="#dc8053" strokeWidth="2.1" d="M14 17h6"/><circle cx="17" cy="13.8" r="1.1" fill="#dc8053"/><circle cx="17" cy="20.2" r="1.1" fill="#dc8053"/></>;
    case "algebra": return <><path {...s} fill="#edf0ff" d="M5 4.5h14v15H5z"/><path {...s} d="m8 9 4 4m0-4-4 4m6-3h3m-1.5-1.5v3M8 17h8"/><circle cx="8" cy="7" r=".8" fill="#6375bc"/></>;
    case "geometry": return <><path {...s} fill="#f0eaff" d="M4.5 19 11 5l7.8 14z"/><path {...s} d="M7 14h2m-1 2h2m-1 2h2M12 8.5l1.1 1.7"/><circle cx="11" cy="5" r="1" fill="#896dbd"/><circle cx="4.5" cy="19" r="1" fill="#896dbd"/><circle cx="18.8" cy="19" r="1" fill="#896dbd"/></>;
    case "statistics": return <><path {...s} fill="#eaf5f8" d="M5 4.5h14v15H5z"/><path {...s} d="M8 16v-4m4 4V8m4 8v-6m-9 7h10"/><circle cx="8" cy="10" r="1" fill="#4b91a2"/><circle cx="12" cy="6" r="1" fill="#d29545"/><circle cx="16" cy="9" r="1" fill="#6486bd"/></>;
    case "history": return <><path stroke="#9b765c" strokeWidth="1" strokeLinejoin="round" fill="#e8c4a1" d="M9 5c4-1 6.8 1.1 7 4.1l2 2.4-2.1.6.1 2.6c0 1.6-1.2 2.8-3 2.9l-.4 2.2H8.2l.4-4.6C6.7 13.2 6 8.4 9 5z"/><path fill="#414343" d="M7 11.7 6.3 8C5.6 4.4 9.1 2 12.8 2.5c2.3.3 3.8 1.4 4.2 3.4l-2-.6c-1.2 1.6-3.2.8-5.4 2.2l-.3 4.4z"/><path stroke="#a3a49b" strokeWidth=".8" strokeLinecap="round" fill="none" d="M8.3 5.5c1.8-1.5 4.1-1.6 6.1-.8M9 4c1.7-.8 3.3-.7 4.8-.2"/><path fill="#414343" d="M13.4 11.9c1.4-.8 3-.4 3.9 1l-.9 1.4c-.8-.5-1.5-.6-2.2-.5l-1.6-.8z"/><path stroke="#4b4540" strokeWidth="1" strokeLinecap="round" fill="none" d="m13.4 8.9 2 .2"/><circle fill="#383a39" cx="15" cy="10" r=".55"/><path stroke="#aa8264" strokeWidth=".8" fill="none" d="M9.5 10c-1.5-.5-1.8 2-.4 2.5"/><path stroke="#526754" strokeWidth="1" strokeLinejoin="round" fill="#84947c" d="m7.5 16.5 2.4 1.6 3.4-1.4 3.7 2.4 1.1 3H4.7l.8-3z"/><path stroke="#536752" strokeWidth="1" fill="#a8b19a" d="m7.5 16.5 2.4 1.6-1 2-2.2-2m6.6-1.4-3.4 1.4 1.5 2 3.4-2"/><circle fill="#d6bd68" cx="11" cy="21" r=".65"/></>;
    case "society": return <><circle {...s} fill="#e7f4eb" cx="12" cy="8" r="3"/><circle {...s} fill="#f6e5d4" cx="6" cy="10" r="2"/><circle {...s} fill="#e6e7fa" cx="18" cy="10" r="2"/><path {...s} fill="#d8eddf" d="M6 18c0-3.4 2.4-5.5 6-5.5s6 2.1 6 5.5v1H6z"/><path {...s} d="M4 18c0-2.3.8-3.7 2.4-4.4m13.6 4.4c0-2.3-.8-3.7-2.4-4.4"/></>;
    case "geography": return <><circle {...s} fill="#e4f4e8" cx="12" cy="12" r="8"/><path {...s} d="M4.5 10h15M5.7 15h12.6M12 4c2.1 2.1 3.1 4.8 3.1 8S14.1 17.9 12 20c-2.1-2.1-3.1-4.8-3.1-8S9.9 6.1 12 4z"/><path fill="#62a878" d="m6 8 3-2 1 2-2 2-3-.5zm8 7 2-2 2 1-1 3-3 1z"/></>;
    case "physics": return <><circle {...s} fill="#e5f3ff" cx="12" cy="12" r="2"/><ellipse {...s} cx="12" cy="12" rx="8" ry="3.3"/><ellipse {...s} cx="12" cy="12" rx="8" ry="3.3" transform="rotate(60 12 12)"/><circle cx="19.4" cy="9" r="1.2" fill="#e98954"/></>;
    case "chemistry": return <><path {...s} fill="#f0f6de" d="M9 4h6M10 4v6l-5 8.5c-.5.8.1 1.5 1 1.5h12c.9 0 1.5-.7 1-1.5L14 10V4"/><path {...s} d="M7.2 16h9.6"/><circle cx="10" cy="14" r=".8" fill="#8cb858"/><circle cx="14.5" cy="17.5" r=".8" fill="#df9d57"/></>;
    case "biology": return <><path {...s} fill="#e8f5e8" d="M19.5 4.5C11 4.5 5 7.5 5 14c0 3.2 2.2 5.5 5.3 5.5 6.4 0 9.2-7.2 9.2-15z"/><path {...s} d="M5 20c3-5.2 6.4-8.3 12-11m-8 6c-.1-1.7-.9-2.8-2.2-3.5m6-1.3c1.5.1 2.8-.5 3.8-1.7"/></>;
    case "world": return <><circle {...s} fill="#fff2d8" cx="18" cy="6" r="2.5"/><path {...s} d="M18 2.5v1m0 5v1m-3.5-3.5h1m5 0h1"/><path {...s} fill="#e7f1df" d="M5 19h14M7 18c.2-4.1 2.1-6.9 5-6.9s4.8 2.8 5 6.9M12 11v8m-3.5-4.5 3.5 2 3.5-2"/><path {...s} d="M10 11c0-1.8.8-2.7 2-3.2 1.2.5 2 1.4 2 3.2"/></>;
    case "informatics": return <><rect {...s} fill="#e8f5fa" x="4" y="5" width="16" height="12" rx="2"/><path {...s} d="M9 20h6m-3-3v3M8 9l-2 2 2 2m8-4 2 2-2 2m-3-5-2 6"/><circle cx="17.5" cy="7.5" r=".7" fill="#55a4af"/></>;
    case "technology": return <><path {...s} stroke="#9b6943" fill="#e8b77c" d="M9.5 9.5h3v10a1.5 1.5 0 0 1-3 0z"/><path {...s} stroke="#65748a" fill="#dce4ee" d="M3.5 4.5h10c3 0 5.1 1.6 7 4.5l-3.5.5L14 7.5h-1.5V11h-9z"/><path {...s} stroke="#8a9aad" d="M6 5v5"/></>;
    case "art": return <><path {...s} fill="#fae9f1" d="M12 3.5a8.5 8.5 0 1 0 0 17h1.1a2.2 2.2 0 0 0 1.5-3.8 1.4 1.4 0 0 1 1-2.4H17a3.5 3.5 0 0 0 3.5-3.5A8.5 8.5 0 0 0 12 3.5z"/><circle cx="8" cy="10" r="1" fill="#d46d89"/><circle cx="11" cy="7" r="1" fill="#e0a94e"/><circle cx="15" cy="8" r="1" fill="#647fc8"/><circle cx="17" cy="11" r="1" fill="#60a77b"/></>;
    case "music": return <><path {...s} fill="#f3e9fa" d="M10 5v11.2a2.7 2.7 0 1 1-1.7-2.5V7l9-2v9.2a2.7 2.7 0 1 1-1.7-2.5V4.5z"/><path {...s} d="m10 8 7-1.6"/></>;
    case "sport": return <><circle {...s} stroke="#96532d" fill="#eea15c" cx="12" cy="12" r="8.5"/><path {...s} stroke="#96532d" d="M3.5 12h17M12 3.5v17M6 6c5.2 2.3 5.2 9.7 0 12M18 6c-5.2 2.3-5.2 9.7 0 12"/></>;
    case "safety": return <><path {...s} fill="#e8efff" d="M12 3.5 19 6v5.3c0 4.3-2.7 7.5-7 9.2-4.3-1.7-7-4.9-7-9.2V6z"/><path {...s} d="M12 7v6m0 3h.01"/><path {...s} stroke="#6687cc" d="M8 7.5h8"/></>;
    case "ethics": return <path {...s} stroke="#b28339" strokeWidth="2.4" d="M12 3v18M9 6h6M6.5 10h11M9 15l6 2"/>;
  }
}
