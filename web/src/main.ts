import "@material/web/button/filled-button.js";
import "@material/web/button/filled-tonal-button.js";
import "@material/web/button/text-button.js";
import "@material/web/chips/chip-set.js";
import "@material/web/chips/input-chip.js";
import "@material/web/icon/icon.js";
import "@material/web/iconbutton/icon-button.js";
import "@material/web/list/list.js";
import "@material/web/button/outlined-button.js";
import "@material/web/list/list-item.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/textfield/outlined-text-field.js";
import { styles as typescaleStyles } from "@material/web/typography/md-typescale-styles.js";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-500.css";
import "@fontsource/roboto/latin-700.css";
import "./styles.css";
import { dispatch, notFound, route } from "./router";
import { lang } from "./i18n";
import { renderHome } from "./views/home";
import { initPwa } from "./pwa";

// The group view (and everything it pulls in) is its own chunk (#18): the home page loads less.
const group = () => import("./views/group");
const join = () => import("./views/join");

if (typescaleStyles.styleSheet) document.adoptedStyleSheets.push(typescaleStyles.styleSheet);

lang(); // resolves the saved/browser language and sets <html lang> before the first render
initPwa();
const root = document.getElementById("app")!;

route("/", () => renderHome(root));
route("/g/:id", async ({ id }) => (await group()).renderGroup(root, id));
route("/v/:id", async ({ id }) => (await group()).renderGroup(root, id, "view"));
route("/join/:token", async ({ token }) => (await join()).renderJoin(root, token));
notFound(() => renderHome(root));

dispatch();
