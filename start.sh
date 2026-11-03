#!/bin/bash
# ============================================
# 卡密系统一键启动 (双实例)
#   :3000 管理端/代理端    :3010 客户端领取页
# 用法: bash start.sh
# ============================================
cd "$(dirname "$0")"

pkill -f "node index.js" 2>/dev/null
sleep 1

cd backend/server
KAMI_MODE=admin nohup node index.js > /tmp/kami_node.log 2>&1 &
echo "✅ 管理端/代理端 :3000 (日志 /tmp/kami_node.log)"

KAMI_MODE=client PORT=3010 nohup node index.js > /tmp/kami_client.log 2>&1 &
echo "✅ 客户端领取页 :3010 (日志 /tmp/kami_client.log)"

cd ../../claim_api
nohup python3 -m uvicorn app:app --host 0.0.0.0 --port 8888 > /tmp/claim_api.log 2>&1 &
echo "✅ 协议执行层 :8888 内部 (日志 /tmp/claim_api.log)"

sleep 3
echo ""
echo "=== 健康检查 ==="
curl -s -m 3 http://127.0.0.1:3000/health && echo " ← 管理端 :3000"
curl -s -m 3 http://127.0.0.1:3010/health && echo " ← 客户端 :3010"
curl -s -m 3 http://127.0.0.1:8888/api/health && echo " ← claim-api :8888"
echo ""
echo "管理后台: http://127.0.0.1:3000"
echo "客户端:   http://127.0.0.1:3010/claim?kami=卡密"
echo "停止: pkill -f 'node index.js'; pkill -f 'uvicorn app:app'"
