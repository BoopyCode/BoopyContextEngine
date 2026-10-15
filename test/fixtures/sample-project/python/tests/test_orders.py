from python.analytics.orders import OrderAnalytics, build_report


def test_total_revenue() -> None:
    analytics = OrderAnalytics([{"user_id": 1, "total_cents": 500}])
    assert analytics.total_revenue_cents() == 500
    assert "total=500" in build_report([{"user_id": 1, "total_cents": 500}])
