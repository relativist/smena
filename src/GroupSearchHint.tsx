import InfoTooltip from "./InfoTooltip";
import { GROUP_SEARCH_HELP } from "../shared/groupSearch";
import "./group-search.css";

export default function GroupSearchHint() {
  return <InfoTooltip label="Поиск групп">{GROUP_SEARCH_HELP}</InfoTooltip>;
}
