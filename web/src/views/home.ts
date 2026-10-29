import { api, ApiError, type MyGroup } from "../api";
import { clear, h, icon, snackbar } from "../dom";
import { CURRENCIES, defaultCurrency } from "../money";
import { forgetGroup, recentGroups, type RecentGroup } from "../store";
import { navigate } from "../router";
import { themeButton } from "../theme";
import { detachPullToRefresh } from "../gestures";
import { dispatch } from "../router";
import { lang, setLang, t } from "../i18n";

type TextField = HTMLElement & { value: string; error: boolean; errorText: string; reportValidity(): boolean };

/** Server trips (linked to me) first; this-device-only ones (e.g. not claimed yet) after, marked. */
type Trip = { id: string; name: string; currency: string; archived?: boolean; memberName?: string; local?: boolean };
let lastMine: MyGroup[] | null = null; // last server answer: avoids a flash of the local list on re-render

function mergeTrips(mine: MyGroup[] | null, local: RecentGroup[]): Trip[] {
  if (!mine) return local;
  const ids = new Set(mine.map((g) => g.id));
  return [...mine, ...local.filter((g) => !ids.has(g.id)).map((g) => ({ ...g, local: true }))];
}

export function renderHome(root: HTMLElement) {
  detachPullToRefresh(); // the group view's pull-to-refresh must not fire here
  document.title = t("home.title");
  const members: string[] = [];

  const nameField = h("md-outlined-text-field", {
    label: t("home.groupName"),
    placeholder: t("home.groupNamePh"),
    required: true,
    maxLength: 60,
    dataset: { testid: "group-name" },
  }) as TextField;

  const currency = h("md-outlined-select", { quick: true, label: t("home.currency"), class: "currency-select", dataset: { testid: "group-currency" } },
    CURRENCIES.map((c) => h("md-select-option", { value: c, selected: c === defaultCurrency() }, h("div", { slot: "headline" }, c))),
  ) as HTMLElement & { value: string };

  const memberField = h("md-outlined-text-field", {
    label: t("member.add"),
    placeholder: t("common.name"),
    supportingText: t("home.youFirst"),
    maxLength: 60,
    dataset: { testid: "member-input" },
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        addMember();
      }
    },
  }) as TextField;
  memberField.append(
    h("md-icon-button", { type: "button", slot: "trailing-icon", "aria-label": t("member.add"), onclick: () => addMember(), dataset: { testid: "member-add" } }, icon("person_add")),
  );

  const chips = h("md-chip-set", { class: "member-chips", dataset: { testid: "member-chips" } });

  function renderChips() {
    clear(
      chips,
      members.map((m, i) =>
        h("md-input-chip", {
          // The first person is the creator: they get linked to it (api.createGroup `me` = 0).
          label: i === 0 ? t("home.youChip", { name: m }) : m,
          dataset: { testid: i === 0 ? "member-chip-you" : "member-chip" },
          onremove: (e: Event) => {
            e.preventDefault();
            members.splice(i, 1);
            renderChips();
          },
        }),
      ),
    );
  }

  function addMember(): boolean {
    const name = memberField.value.trim().replace(/\s+/g, " ");
    memberField.error = false;
    if (!name) return false;
    if (members.some((m) => m.toLowerCase() === name.toLowerCase())) {
      memberField.error = true;
      memberField.errorText = t("home.alreadyAdded");
      return false;
    }
    if (members.length >= 50) {
      memberField.error = true;
      memberField.errorText = t("home.atMost50");
      return false;
    }
    members.push(name);
    memberField.value = "";
    renderChips();
    return true;
  }

  const createBtn = h(
    "md-filled-button",
    { type: "submit", dataset: { testid: "create-group" } },
    icon("group_add", "icon"),
    t("home.createGroup"),
  ) as HTMLElement & { disabled: boolean };

  const form = h(
    "form",
    {
      class: "stack",
      novalidate: true,
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (memberField.value.trim()) addMember();
        nameField.error = false;
        if (!nameField.value.trim()) {
          nameField.error = true;
          nameField.errorText = t("home.nameRequired");
          nameField.focus();
          return;
        }
        if (!members.length) {
          memberField.error = true;
          memberField.errorText = t("home.addAtLeastOne");
          memberField.focus();
          return;
        }
        createBtn.disabled = true;
        try {
          const { group } = await api.createGroup(nameField.value.trim(), currency.value || "USD", members);
          navigate(`/g/${group.id}`);
        } catch (err) {
          snackbar(err instanceof ApiError ? err.message : t("home.createFailed"));
        } finally {
          createBtn.disabled = false;
        }
      },
    },
    h("div", { class: "row wrap" }, h("div", { class: "grow" }, nameField), currency),
    memberField,
    chips,
    h("div", { class: "row end" }, createBtn),
  );

  const line = (g: Trip) =>
    [g.archived ? t("home.archivedLine", { currency: g.currency }) : g.currency, g.memberName && t("home.asName", { name: g.memberName }), g.local && t("home.notLinked")]
      .filter(Boolean).join(" · ");

  /** "Your groups" card (or the empty-state card). Rebuilt on its own when the server list arrives, so the form
   *  next to it is never replaced while someone types. */
  const tripsCard = () => {
    // Archived groups sink to the bottom.
    const trips = mergeTrips(lastMine, recentGroups()).sort((a, b) => Number(!!a.archived) - Number(!!b.archived));
    const recentList = h(
      "md-list",
      { dataset: { testid: "recent-groups" } },
      trips.map((g) =>
        h(
          "md-list-item",
          { type: "link", href: `/g/${g.id}`, dataset: { testid: g.local ? "trip-local" : lastMine ? "trip-mine" : "trip" }, onclick: (e: Event) => { e.preventDefault(); navigate(`/g/${g.id}`); } },
          h("div", { slot: "headline" }, g.name),
          h("div", { slot: "supporting-text" }, line(g)),
          icon(g.archived ? "archive" : "groups", "start"),
          // Server trips can't be hidden from the list (you're in them); this-device entries can.
          g.local && h(
            "md-icon-button",
            {
              slot: "end",
              "aria-label": t("home.removeFromList", { name: g.name }),
              onclick: (e: Event) => {
                e.preventDefault();
                e.stopPropagation();
                forgetGroup(g.id);
                renderHome(root);
              },
            },
            icon("close"),
          ),
        ),
      ),
    );

    return trips.length
      ? h("section", { class: "card" }, h("h2", { class: "md-typescale-title-medium" }, t("common.yourGroups")), recentList)
      : h(
          "section",
          { class: "card tonal" },
          h("h2", { class: "md-typescale-title-medium" }, t("home.howItWorks")),
          h(
            "ol",
            { class: "how md-typescale-body-medium" },
            h("li", null, t("home.how1")),
            h("li", null, t("home.how2")),
            h("li", null, t("home.how3")),
            h("li", null, t("home.how4")),
          ),
          h("md-filled-tonal-button", {
            dataset: { testid: "try-sample" },
            onclick: async (e: Event) => {
              const btn = e.currentTarget as HTMLElement & { disabled: boolean };
              btn.disabled = true;
              try {
                const { createSampleGroup } = await import("../sample");
                navigate(`/g/${await createSampleGroup()}`);
              } catch (err) {
                snackbar(err instanceof ApiError ? err.message : t("home.sampleFailed"));
                btn.disabled = false;
              }
            },
          }, icon("local_activity", "icon"), t("home.trySample")),
        );
  };
  let card = tripsCard();
  const formCard = h("section", { class: "card new-trip" }, h("h2", { class: "md-typescale-title-medium" }, t("home.newGroup")), form);
  // Coming back: your trips first. First visit: the form first, "how it works" next to it.
  const returning = mergeTrips(lastMine, recentGroups()).length > 0;

  clear(
    root,
    h(
      "header",
      { class: "top-app-bar" },
      h("div", { class: "brand" }, icon("receipt_long"), h("span", { class: "md-typescale-title-large" }, "Share")),
      h("div", { class: "actions push-right" },
        h("md-text-button", {
          "aria-label": t("lang.switchAria"), title: t("lang.switchAria"), dataset: { testid: "lang-toggle-home" },
          onclick: () => { setLang(lang() === "th" ? "en" : "th"); dispatch(); },
        }, icon("translate", "icon"), t("lang.switchTo")),
        themeButton()),
    ),
    h(
      "main",
      { class: "page home", id: "main" },
      h(
        "section",
        { class: `hero ${returning ? "compact" : ""}` },
        h("h1", { class: "md-typescale-display-small" }, t("home.heroTitle")),
        h("p", { class: "md-typescale-body-large muted" }, t("home.heroText")),
      ),
      h("div", { class: "home-grid" }, ...(returning ? [card, formCard] : [formCard, card])),
    ),
  );

  api.myGroups().then(({ groups }) => {
    const changed = JSON.stringify(groups) !== JSON.stringify(lastMine);
    lastMine = groups;
    // Swap just the list card, and only while it's still on screen (not after navigating away).
    if (changed && card.isConnected) {
      const next = tripsCard();
      card.replaceWith(next);
      card = next;
    }
  }, () => undefined);
}
