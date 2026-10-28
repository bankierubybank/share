// /join/<token> (v0.6): someone opened an invite link. They pick who they are in the trip (or add themselves);
// the server links their Access identity to that person, then we open the trip.
import "@material/web/progress/circular-progress.js";
import { api, ApiError, type JoinInfo } from "../api";
import { clear, h, icon, snackbar } from "../dom";
import { navigate } from "../router";
import { t } from "../i18n";

type Field = HTMLElement & { value: string; error: boolean; errorText: string };

export async function renderJoin(root: HTMLElement, token: string) {
  const here = location.pathname;
  const stillHere = () => location.pathname === here;
  const bar = (title: string) =>
    h("header", { class: "top-app-bar" },
      h("md-icon-button", { "aria-label": t("group.backHome"), onclick: () => navigate("/"), dataset: { testid: "nav-home" } }, icon("arrow_back")),
      h("h1", { class: "md-typescale-title-large title" }, title));
  const problem = (text: string, ic: "search_off" | "archive" | "cloud_off") =>
    clear(root, bar(t("invite.title")),
      h("main", { class: "page center stack", id: "main", dataset: { testid: "join-error" } },
        icon(ic),
        h("p", { class: "md-typescale-body-large", role: "alert" }, text),
        h("md-filled-button", { onclick: () => navigate("/") }, t("common.goHome"))));

  clear(root, bar(t("invite.title")), h("main", { class: "page center", id: "main" }, h("md-circular-progress", { indeterminate: true, "aria-label": t("common.loading") })));

  let info: JoinInfo;
  try {
    info = await api.joinInfo(token);
  } catch (e) {
    if (!stillHere()) return;
    if (e instanceof ApiError && e.status === 404) return problem(t("join.gone"), "search_off");
    if (e instanceof ApiError && e.code === "archived") return problem(t("join.archived"), "archive");
    return problem(e instanceof Error ? e.message : t("common.somethingWrong"), "cloud_off");
  }
  if (!stillHere()) return;
  if (info.joined) return navigate(`/g/${info.groupId}`, true);

  const name = info.group.name;
  const done = (groupId: string) => {
    snackbar(t("join.joinedToast", { name }));
    navigate(`/g/${groupId}`, true);
  };
  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 404) return problem(t("join.gone"), "search_off");
    snackbar(e instanceof Error ? e.message : t("common.saveFailed"));
  };

  const field = h("md-outlined-text-field", { label: t("join.yourName"), maxLength: 40, dataset: { testid: "join-name" } }) as Field;
  const joinNew = async () => {
    if (!field.value.trim()) {
      field.error = true;
      field.errorText = t("join.yourName");
      return;
    }
    try {
      done((await api.join(token, { name: field.value })).groupId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        field.error = true;
        field.errorText = e.message;
      } else fail(e);
    }
  };
  field.addEventListener("keydown", (ev) => { if ((ev as KeyboardEvent).key === "Enter") void joinNew(); });

  clear(root, bar(t("invite.title")),
    h("main", { class: "page stack", id: "main", dataset: { testid: "join-view" } },
      h("h1", { class: "md-typescale-headline-small", dataset: { testid: "join-title" } }, t("join.title", { name })),
      h("p", { class: "md-typescale-body-medium muted" }, t("join.pick")),
      h("md-list", { "aria-label": t("join.pick") }, info.members.map((m) =>
        h("md-list-item", {
          type: "button", disabled: m.taken, dataset: { testid: `join-member-${m.name}` },
          onclick: async () => {
            if (m.taken) return;
            try {
              done((await api.join(token, { memberId: m.id })).groupId);
            } catch (e) {
              fail(e);
            }
          },
        },
        h("div", { slot: "start", class: "avatar initial", "aria-hidden": "true" }, [...m.name][0]?.toUpperCase() ?? "?"),
        h("div", { slot: "headline" }, m.name),
        m.taken && h("div", { slot: "supporting-text" }, t("join.taken"))))),
      h("h2", { class: "md-typescale-title-small" }, t("join.notListed")),
      h("div", { class: "row wrap" },
        field,
        h("md-filled-button", { type: "button", onclick: joinNew, dataset: { testid: "join-new" } }, icon("person_add", "icon"), t("join.asNew")))));
}
