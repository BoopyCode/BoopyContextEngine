"""Order analytics used by the reporting jobs."""

from __future__ import annotations


class OrderAnalytics:
    """Aggregates order revenue per user."""

    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows

    def total_revenue_cents(self) -> int:
        return sum(int(row["total_cents"]) for row in self.rows)

    def revenue_per_user(self) -> dict[str, int]:
        totals: dict[str, int] = {}
        for row in self.rows:
            key = str(row["user_id"])
            totals[key] = totals.get(key, 0) + int(row["total_cents"])
        return totals


def build_report(rows: list[dict]) -> str:
    analytics = OrderAnalytics(rows)
    return f"total={analytics.total_revenue_cents()} users={len(analytics.revenue_per_user())}"
