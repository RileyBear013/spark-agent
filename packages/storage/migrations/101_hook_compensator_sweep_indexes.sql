-- 101: Hook 补偿扫描器查询索引
-- agent_events 增长到百万行级后，HookCompensator 每 60 秒的扫描查询
--   WHERE event_type = ? AND created_at > ? ORDER BY created_at LIMIT ?
-- 走全表扫描 + 临时 B-tree 排序，在主进程同步阻塞事件循环 0.7~1.4 秒，
-- 造成界面间歇性转圈 / 点 Dock 图标无法置前。turn_requests 同查询模式一并覆盖。
-- 注意：本迁移在存量库上首次执行需要全表建索引（一次性成本，秒级）。
CREATE INDEX IF NOT EXISTS idx_agent_events_type_created
  ON agent_events(event_type, created_at);

CREATE INDEX IF NOT EXISTS idx_turn_requests_created
  ON turn_requests(created_at);
