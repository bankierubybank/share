import type { Category } from "./api";
import type { IconName } from "./icons";

export const CATEGORY_META: Record<Category, { label: string; icon: IconName }> = {
  food: { label: "Food & drink", icon: "restaurant" },
  groceries: { label: "Groceries", icon: "shopping_cart" },
  lodging: { label: "Lodging", icon: "hotel" },
  transport: { label: "Transport", icon: "directions_car" },
  activities: { label: "Activities", icon: "local_activity" },
  shopping: { label: "Shopping", icon: "shopping_bag" },
  utilities: { label: "Utilities", icon: "bolt" },
  other: { label: "Other", icon: "receipt" },
};

export const CATEGORY_ORDER = Object.keys(CATEGORY_META) as Category[];
