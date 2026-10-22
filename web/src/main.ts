import "@material/web/button/filled-button.js";
import "@material/web/button/filled-tonal-button.js";
import "@material/web/button/text-button.js";
import "@material/web/checkbox/checkbox.js";
import "@material/web/chips/chip-set.js";
import "@material/web/chips/filter-chip.js";
import "@material/web/chips/input-chip.js";
import "@material/web/dialog/dialog.js";
import "@material/web/fab/fab.js";
import "@material/web/icon/icon.js";
import "@material/web/iconbutton/icon-button.js";
import "@material/web/list/list.js";
import "@material/web/list/list-item.js";
import "@material/web/progress/circular-progress.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/tabs/tabs.js";
import "@material/web/tabs/primary-tab.js";
import "@material/web/textfield/outlined-text-field.js";
import { styles as typescaleStyles } from "@material/web/typography/md-typescale-styles.js";
import "./styles.css";
import { dispatch, notFound, route } from "./router";
import { renderHome } from "./views/home";
import { renderGroup } from "./views/group";

if (typescaleStyles.styleSheet) document.adoptedStyleSheets.push(typescaleStyles.styleSheet);

const root = document.getElementById("app")!;

route("/", () => renderHome(root));
route("/g/:id", ({ id }) => renderGroup(root, id));
notFound(() => renderHome(root));

dispatch();
