import { api, ApiError } from "../api";
import { clear, h, icon, snackbar } from "../dom";
import { CURRENCIES, defaultCurrency } from "../money";
import { forgetGroup, recentGroups } from "../store";
import { navigate } from "../router";
import { themeButton } from "../theme";

type TextField = HTMLElement & { value: string; error: boolean; errorText: string; reportValidity(): boolean };

export function renderHome(root: HTMLElement) {
  document.title = "Share — split bills";
  const members: string[] = [];

  const nameField = h("md-outlined-text-field", {
    label: "Group name",
    placeholder: "Bangkok trip, Flat 4B…",
    required: true,
    maxLength: 60,
    dataset: { testid: "group-name" },
  }) as TextField;

  const currency = h("md-outlined-select", { quick: true, label: "Currency", dataset: { testid: "group-currency" } },
    CURRENCIES.map((c) => h("md-select-option", { value: c, selected: c === defaultCurrency() }, h("div", { slot: "headline" }, c))),
  ) as HTMLElement & { value: string };

  const memberField = h("md-outlined-text-field", {
    label: "Add person",
    placeholder: "Name",
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
    h("md-icon-button", { type: "button", slot: "trailing-icon", "aria-label": "Add person", onclick: () => addMember(), dataset: { testid: "member-add" } }, icon("person_add")),
  );

  const chips = h("md-chip-set", { class: "member-chips", dataset: { testid: "member-chips" } });

  function renderChips() {
    clear(
      chips,
      members.map((m, i) =>
        h("md-input-chip", {
          label: m,
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
      memberField.errorText = "Already added";
      return false;
    }
    if (members.length >= 50) {
      memberField.error = true;
      memberField.errorText = "At most 50 people";
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
    "Create group",
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
          nameField.errorText = "Give the group a name";
          nameField.focus();
          return;
        }
        if (!members.length) {
          memberField.error = true;
          memberField.errorText = "Add at least one person";
          memberField.focus();
          return;
        }
        createBtn.disabled = true;
        try {
          const { group } = await api.createGroup(nameField.value.trim(), currency.value || "USD", members);
          navigate(`/g/${group.id}`);
        } catch (err) {
          snackbar(err instanceof ApiError ? err.message : "Could not create group");
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

  // Archived groups sink to the bottom.
  const recent = recentGroups().sort((a, b) => Number(!!a.archived) - Number(!!b.archived));
  const recentList = h(
    "md-list",
    { dataset: { testid: "recent-groups" } },
    recent.map((g) =>
      h(
        "md-list-item",
        { type: "link", href: `/g/${g.id}`, onclick: (e: Event) => { e.preventDefault(); navigate(`/g/${g.id}`); } },
        h("div", { slot: "headline" }, g.name),
        h("div", { slot: "supporting-text" }, g.archived ? `${g.currency} · Archived` : g.currency),
        icon(g.archived ? "archive" : "groups", "start"),
        h(
          "md-icon-button",
          {
            slot: "end",
            "aria-label": `Remove ${g.name} from this list`,
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

  clear(
    root,
    h(
      "header",
      { class: "top-app-bar" },
      h("div", { class: "brand" }, icon("receipt_long"), h("span", { class: "md-typescale-title-large" }, "Share")),
      h("div", { class: "actions push-right" }, themeButton()),
    ),
    h(
      "main",
      { class: "page home", id: "main" },
      h(
        "section",
        { class: "hero" },
        h("h1", { class: "md-typescale-display-small" }, "Split bills, not friendships"),
        h("p", { class: "md-typescale-body-large muted" }, "Create a group, add who's in, log what was paid. Share works out who owes whom."),
      ),
      h(
        "div",
        { class: "home-grid" },
        h("section", { class: "card" }, h("h2", { class: "md-typescale-title-medium" }, "New group"), form),
        recent.length
          ? h("section", { class: "card" }, h("h2", { class: "md-typescale-title-medium" }, "Your groups"), recentList)
          : h(
              "section",
              { class: "card tonal" },
              h("h2", { class: "md-typescale-title-medium" }, "How it works"),
              h(
                "ol",
                { class: "how md-typescale-body-medium" },
                h("li", null, "Create a group and add people."),
                h("li", null, "Add bills: who paid, who shares."),
                h("li", null, "Check Summary for who pays whom."),
                h("li", null, "Share the link with your group."),
              ),
            ),
      ),
    ),
  );
}
