#!/bin/bash
echo "🚀 BriLeX Kurulum Başlıyor..."

# Sistem güncelle
sudo apt update -y
sudo apt upgrade -y

# Node.js kur
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs

# GPIO kur
sudo apt install -y pigpio pigpio-tools
sudo systemctl enable pigpiod
sudo systemctl start pigpiod

# Chromium kur
sudo apt install -y chromium-browser x11-xserver-utils unclutter

# Proje dizini
PROJECT_DIR="/home/pi/brilex"
mkdir -p $PROJECT_DIR/public
cd $PROJECT_DIR

# Package.json oluştur
curl -sSL https://raw.githubusercontent.com/YOUR_USERNAME/brilex/main/package.json > package.json

# Server.js indir
curl -sSL https://raw.githubusercontent.com/YOUR_USERNAME/brilex/main/server.js > server.js

# HTML indir
curl -sSL https://raw.githubusercontent.com/YOUR_USERNAME/brilex/main/public/index.html > public/index.html

# NPM install
npm install

echo "✅ Kurulum tamamlandı!"
echo "🚀 Başlatmak için: cd $PROJECT_DIR && npm start"
