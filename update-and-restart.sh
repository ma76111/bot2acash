#!/bin/bash
cd /root/egypt-easy-cash-bot
git pull
pm2 restart egypt-bot
pm2 logs egypt-bot --lines 20
