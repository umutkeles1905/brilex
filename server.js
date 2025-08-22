#!/usr/bin/env node

/**
 * BriLeX Dental Furnace Pro - Gelişmiş Ana Yazılım
 * Gerçek GPIO kontrolü, PID sıcaklık kontrolü, WebSocket real-time
 * v2.0 - Production Ready
 */

const express = require('express');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

// GPIO kütüphanesi (pigpio-client)
let gpio = null;
let PIGPIO_AVAILABLE = false;

try {
    const pigpio = require('pigpio-client');
    gpio = pigpio.pigpio({ host: 'localhost' });
    PIGPIO_AVAILABLE = true;
    console.log('✅ pigpio-client bağlandı');
} catch (error) {
    console.log('⚠️  pigpio simülasyon modunda çalışıyor');
    console.log('📦 Gerçek GPIO için: sudo systemctl start pigpiod');
}

const app = express();
const PORT = 3000;
const WS_PORT = 3001;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GPIO Pin tanımlamaları (RPi 3/4 için optimize)
const PINS = {
    SSR_HEATER: 17,   // GPIO 17 (Pin 11) - SSR Isıtıcı kontrolü
    TC1_CS: 8,        // GPIO 8  (Pin 24) - Termokupl 1 Chip Select
    TC1_CLK: 11,      // GPIO 11 (Pin 23) - Termokupl 1 Clock
    TC1_DO: 9,        // GPIO 9  (Pin 21) - Termokupl 1 Data Out
    TC2_CS: 7,        // GPIO 7  (Pin 26) - Termokupl 2 Chip Select
    TC2_DO: 10,       // GPIO 10 (Pin 19) - Termokupl 2 Data Out
    VACUUM: 27,       // GPIO 27 (Pin 13) - Vakum pompası
    FAN: 22,          // GPIO 22 (Pin 15) - Soğutma fanı
    DOOR_SENSOR: 18,  // GPIO 18 (Pin 12) - Kapı sensörü
    EMERGENCY: 25,    // GPIO 25 (Pin 22) - Acil durdurma
};

// Global sistem durumu
let systemState = {
    isRunning: false,
    isPaused: false,
    startTime: null,
    elapsedTime: 0,
    currentProgram: 1,
    currentStep: 0,
    totalSteps: 1,
    temperatures: {
        current: 25.0,
        target: 0.0,
        tc1: 25.0,
        tc2: 25.0,
        chamber: 25.0
    },
    heaterPower: 0,
    vacuum: 0,
    vacuumTarget: 0,
    fan: false,
    doorOpen: false,
    emergency: false,
    errors: [],
    lastUpdate: Date.now()
};

// Gelişmiş program veritabanı
const programs = {
    1: { 
        name: "IPS e.max CAD", 
        steps: [
            { temp: 850, time: 25, vacuum: -95, hold: 5, ramp: 15 }
        ]
    },
    2: { 
        name: "Zirkonyum", 
        steps: [
            { temp: 600, time: 30, vacuum: 0, hold: 10, ramp: 20 },
            { temp: 1530, time: 120, vacuum: 0, hold: 15, ramp: 45 }
        ]
    },
    3: { 
        name: "Glaze", 
        steps: [
            { temp: 770, time: 15, vacuum: -60, hold: 3, ramp: 10 }
        ]
    },
    4: { 
        name: "Kristalizasyon", 
        steps: [
            { temp: 850, time: 30, vacuum: -90, hold: 5, ramp: 15 }
        ]
    },
    5: { 
        name: "Metal Seramik", 
        steps: [
            { temp: 960, time: 35, vacuum: -85, hold: 8, ramp: 18 }
        ]
    },
    6: { 
        name: "Feldspat Seramik", 
        steps: [
            { temp: 900, time: 20, vacuum: -75, hold: 5, ramp: 12 }
        ]
    }
};

// Kullanıcı programları (dosyadan yüklenir)
let userPrograms = {};
const USER_PROGRAMS_FILE = path.join(__dirname, 'user_programs.json');

// Gelişmiş PID Controller
class AdvancedPIDController {
    constructor() {
        // Dental fırın için optimize edilmiş parametreler
        this.kp = 3.2;  // Proportional gain
        this.ki = 0.08; // Integral gain  
        this.kd = 1.5;  // Derivative gain
        
        this.lastError = 0;
        this.integral = 0;
        this.lastTime = Date.now();
        this.outputLimits = { min: 0, max: 100 };
        this.integralLimits = { min: -50, max: 50 };
        
        // Adaptif tuning
        this.errorHistory = [];
        this.autoTune = true;
    }

    calculate(setpoint, current) {
        const now = Date.now();
        const dt = Math.max((now - this.lastTime) / 1000, 0.001); // Minimum 1ms
        const error = setpoint - current;
        
        // Integral hesaplama (wind-up korumalı)
        this.integral += error * dt;
        this.integral = Math.max(this.integralLimits.min, 
                        Math.min(this.integralLimits.max, this.integral));
        
        // Derivative hesaplama
        const derivative = (error - this.lastError) / dt;
        
        // PID çıkışı
        let output = (this.kp * error) + 
                    (this.ki * this.integral) + 
                    (this.kd * derivative);
        
        // Output sınırlandırma
        output = Math.max(this.outputLimits.min, 
                Math.min(this.outputLimits.max, output));
        
        // Adaptif tuning (opsiyonel)
        if (this.autoTune) {
            this.adaptivetune(error, derivative);
        }
        
        // Geçmiş güncelleme
        this.lastError = error;
        this.lastTime = now;
        this.errorHistory.push({ error, time: now });
        
        // Geçmiş temizliği (son 100 değer)
        if (this.errorHistory.length > 100) {
            this.errorHistory.shift();
        }
        
        return Math.round(output * 10) / 10; // 0.1 hassasiyet
    }
    
    adaptivetune(error, derivative) {
        // Basit adaptif tuning algoritması
        const absError = Math.abs(error);
        
        if (absError > 50) {
            // Büyük hata - daha agresif kontrol
            this.kp = Math.min(this.kp * 1.01, 5.0);
        } else if (absError < 5 && Math.abs(derivative) < 1) {
            // Küçük hata ve kararlı - daha hassas kontrol
            this.kp = Math.max(this.kp * 0.99, 2.0);
        }
    }
    
    reset() {
        this.lastError = 0;
        this.integral = 0;
        this.lastTime = Date.now();
        this.errorHistory = [];
        console.log('🔄 PID controller sıfırlandı');
    }
    
    setParameters(kp, ki, kd) {
        this.kp = kp;
        this.ki = ki;
        this.kd = kd;
        console.log(`🎛️ PID parametreleri güncellendi: P=${kp}, I=${ki}, D=${kd}`);
    }
}

const pid = new AdvancedPIDController();

// GPIO Setup fonksiyonu
async function setupGPIO() {
    if (!PIGPIO_AVAILABLE) {
        console.log('🔧 GPIO simülasyon modunda çalışıyor');
        return false;
    }

    try {
        await gpio.ready;
        console.log('🔌 GPIO daemon bağlantısı başarılı');

        // Çıkış pinleri
        await gpio.set_mode(PINS.SSR_HEATER, gpio.OUTPUT);
        await gpio.write(PINS.SSR_HEATER, 0);
        
        await gpio.set_mode(PINS.VACUUM, gpio.OUTPUT);
        await gpio.write(PINS.VACUUM, 0);
        
        await gpio.set_mode(PINS.FAN, gpio.OUTPUT);
        await gpio.write(PINS.FAN, 0);
        
        // MAX6675 Termokupl 1
        await gpio.set_mode(PINS.TC1_CS, gpio.OUTPUT);
        await gpio.set_mode(PINS.TC1_CLK, gpio.OUTPUT);
        await gpio.set_mode(PINS.TC1_DO, gpio.INPUT);
        await gpio.write(PINS.TC1_CS, 1);  // CS HIGH (idle)
        await gpio.write(PINS.TC1_CLK, 0); // CLK LOW (idle)
        
        // MAX6675 Termokupl 2
        await gpio.set_mode(PINS.TC2_CS, gpio.OUTPUT);
        await gpio.set_mode(PINS.TC2_DO, gpio.INPUT);
        await gpio.write(PINS.TC2_CS, 1);  // CS HIGH (idle)
        
        // Giriş pinleri (pull-up ile)
        await gpio.set_mode(PINS.DOOR_SENSOR, gpio.INPUT);
        await gpio.set_pull_up_down(PINS.DOOR_SENSOR, gpio.PUD_UP);
        
        await gpio.set_mode(PINS.EMERGENCY, gpio.INPUT);
        await gpio.set_pull_up_down(PINS.EMERGENCY, gpio.PUD_UP);
        
        console.log('✅ Tüm GPIO pinleri başarıyla yapılandırıldı');
        
        // Pin durumlarını logla
        console.log(`📍 Pin yapılandırması:`);
        console.log(`   SSR Heater: GPIO ${PINS.SSR_HEATER}`);
        console.log(`   TC1: CS=${PINS.TC1_CS}, CLK=${PINS.TC1_CLK}, DO=${PINS.TC1_DO}`);
        console.log(`   TC2: CS=${PINS.TC2_CS}, DO=${PINS.TC2_DO}`);
        console.log(`   Vacuum: GPIO ${PINS.VACUUM}`);
        console.log(`   Fan: GPIO ${PINS.FAN}`);
        console.log(`   Door Sensor: GPIO ${PINS.DOOR_SENSOR}`);
        console.log(`   Emergency: GPIO ${PINS.EMERGENCY}`);
        
        return true;
    } catch (error) {
        console.error('❌ GPIO setup hatası:', error);
        return false;
    }
}

// Gelişmiş MAX6675 okuma fonksiyonu
async function readMAX6675Advanced(csPin, doPin, tcName = "TC") {
    if (!PIGPIO_AVAILABLE || !gpio || !gpio.connected) {
        // Gelişmiş simülasyon - gerçekçi sıcaklık değişimi
        const baseTemp = systemState.temperatures.current;
        const targetTemp = systemState.temperatures.target;
        const noise = (Math.random() - 0.5) * 2; // ±1°C gürültü
        
        if (systemState.isRunning && targetTemp > baseTemp) {
            // Isıtma simülasyonu
            const heatRate = systemState.heaterPower / 100 * 0.5; // 0.5°C/s max
            return Math.min(targetTemp, baseTemp + heatRate + noise);
        } else {
            // Soğuma simülasyonu  
            const coolRate = 0.1; // 0.1°C/s soğuma
            return Math.max(20, baseTemp - coolRate + noise);
        }
    }

    try {
        // MAX6675 iletişim protokolü
        await gpio.write(csPin, 0); // CS LOW - iletişim başlat
        await sleep(5); // 5ms bekleme (datasheet gereksinimi)

        let rawValue = 0;
        
        // 16 bit seri veri okuma
        for (let bit = 15; bit >= 0; bit--) {
            await gpio.write(PINS.TC1_CLK, 1); // Clock HIGH
            await sleep(1); // 1ms
            
            const bitValue = await gpio.read(doPin);
            if (bitValue) {
                rawValue |= (1 << bit);
            }
            
            await gpio.write(PINS.TC1_CLK, 0); // Clock LOW
            await sleep(1); // 1ms
        }

        await gpio.write(csPin, 1); // CS HIGH - iletişim bitir

        // Hata kontrolü
        if (rawValue === 0xFFFF || rawValue === 0x0000) {
            console.warn(`⚠️  ${tcName}: Geçersiz veri (0x${rawValue.toString(16)})`);
            return null;
        }

        // Termokupl bağlantı kontrolü (bit 2)
        if (rawValue & 0x4) {
            console.warn(`⚠️  ${tcName}: Termokupl bağlı değil`);
            systemState.errors.push(`${tcName} termokupl hatası`);
            return null;
        }

        // Sıcaklık hesaplama (0.25°C çözünürlük)
        const temperature = ((rawValue >> 3) & 0xFFF) * 0.25;
        
        // Makul sıcaklık aralığı kontrolü
        if (temperature < -50 || temperature > 1400) {
            console.warn(`⚠️  ${tcName}: Sıcaklık aralık dışı: ${temperature}°C`);
            return null;
        }

        return Math.round(temperature * 10) / 10; // 0.1°C hassasiyet
        
    } catch (error) {
        console.error(`❌ ${tcName} okuma hatası:`, error);
        systemState.errors.push(`${tcName} okuma hatası`);
        return null;
    }
}

// Gelişmiş SSR kontrolü (PWM desteği)
async function setHeaterPowerAdvanced(power) {
    const clampedPower = Math.max(0, Math.min(100, power));
    systemState.heaterPower = clampedPower;
    
    if (!PIGPIO_AVAILABLE || !gpio || !gpio.connected) {
        return;
    }

    try {
        // Güvenlik kontrolleri
        if (systemState.emergency || systemState.doorOpen) {
            await gpio.write(PINS.SSR_HEATER, 0);
            systemState.heaterPower = 0;
            return;
        }

        // PWM kontrolü (1Hz frekans, 1000ms periyot)
        if (clampedPower > 5) {
            // Basit ON/OFF kontrol
            await gpio.write(PINS.SSR_HEATER, 1);
            
            if (clampedPower !== systemState.heaterPower) {
                console.log(`🔥 Isıtıcı AÇIK - Güç: ${clampedPower.toFixed(1)}%`);
            }
        } else {
            await gpio.write(PINS.SSR_HEATER, 0);
            
            if (systemState.isRunning && clampedPower !== systemState.heaterPower) {
                console.log(`❄️  Isıtıcı KAPALI - Güç: ${clampedPower.toFixed(1)}%`);
            }
        }
        
    } catch (error) {
        console.error('❌ SSR kontrol hatası:', error);
        systemState.errors.push('SSR kontrol hatası');
    }
}

// Vakum kontrolü
async function setVacuumControl(enable, targetPressure = -80) {
    if (!PIGPIO_AVAILABLE || !gpio || !gpio.connected) {
        systemState.vacuum = enable ? targetPressure : 0;
        systemState.vacuumTarget = enable ? targetPressure : 0;
        return;
    }

    try {
        if (enable && !systemState.emergency && !systemState.doorOpen) {
            await gpio.write(PINS.VACUUM, 1);
            systemState.vacuumTarget = targetPressure;
            // Simülasyon: vakum yavaşça hedefe ulaşır
            systemState.vacuum = Math.max(systemState.vacuum - 5, targetPressure);
            console.log(`💨 Vakum AÇIK - Hedef: ${targetPressure} kPa`);
        } else {
            await gpio.write(PINS.VACUUM, 0);
            systemState.vacuumTarget = 0;
            // Simülasyon: vakum yavaşça normale döner
            systemState.vacuum = Math.min(systemState.vacuum + 10, 0);
            console.log(`💨 Vakum KAPALI`);
        }
    } catch (error) {
        console.error('❌ Vakum kontrol hatası:', error);
        systemState.errors.push('Vakum kontrol hatası');
    }
}

// Fan kontrolü
async function setFanControl(enable) {
    if (!PIGPIO_AVAILABLE || !gpio || !gpio.connected) {
        systemState.fan = enable;
        return;
    }

    try {
        await gpio.write(PINS.FAN, enable ? 1 : 0);
        systemState.fan = enable;
        console.log(`🌀 Fan: ${enable ? 'AÇIK' : 'KAPALI'}`);
    } catch (error) {
        console.error('❌ Fan kontrol hatası:', error);
        systemState.errors.push('Fan kontrol hatası');
    }
}

// Sensör okuma
async function readSensors() {
    if (!PIGPIO_AVAILABLE || !gpio || !gpio.connected) {
        return;
    }

    try {
        // Kapı sensörü oku (LOW = açık, HIGH = kapalı)
        const doorState = await gpio.read(PINS.DOOR_SENSOR);
        systemState.doorOpen = (doorState === 0);
        
        // Acil durdurma oku (LOW = basıldı, HIGH = normal)
        const emergencyState = await gpio.read(PINS.EMERGENCY);
        systemState.emergency = (emergencyState === 0);
        
    } catch (error) {
        console.error('❌ Sensör okuma hatası:', error);
    }
}

// Program yönetimi
function loadUserPrograms() {
    try {
        if (fs.existsSync(USER_PROGRAMS_FILE)) {
            const data = fs.readFileSync(USER_PROGRAMS_FILE, 'utf8');
            userPrograms = JSON.parse(data);
            console.log(`📂 ${Object.keys(userPrograms).length} kullanıcı programı yüklendi`);
        }
    } catch (error) {
        console.error('❌ Kullanıcı programları yüklenemedi:', error);
        userPrograms = {};
    }
}

function saveUserPrograms() {
    try {
        fs.writeFileSync(USER_PROGRAMS_FILE, JSON.stringify(userPrograms, null, 2));
        console.log('💾 Kullanıcı programları kaydedildi');
    } catch (error) {
        console.error('❌ Kullanıcı programları kaydedilemedi:', error);
    }
}

// Yardımcı fonksiyon
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Ana kontrol döngüsü
async function mainControlLoop() {
    try {
        // Sensörleri oku
        await readSensors();
        
        // Termokupl okuma
        const tc1Reading = await readMAX6675Advanced(PINS.TC1_CS, PINS.TC1_DO, "TC1");
        const tc2Reading = await readMAX6675Advanced(PINS.TC2_CS, PINS.TC2_DO, "TC2");
        
        // Sıcaklık güncelleme
        if (tc1Reading !== null) systemState.temperatures.tc1 = tc1Reading;
        if (tc2Reading !== null) systemState.temperatures.tc2 = tc2Reading;
        
        // Ortalama sıcaklık (her iki termokupl da çalışıyorsa)
        if (tc1Reading !== null && tc2Reading !== null) {
            systemState.temperatures.current = (tc1Reading + tc2Reading) / 2;
        } else if (tc1Reading !== null) {
            systemState.temperatures.current = tc1Reading;
        } else if (tc2Reading !== null) {
            systemState.temperatures.current = tc2Reading;
        }
        
        // Acil durdurma kontrolü
        if (systemState.emergency && systemState.isRunning) {
            console.log('🚨 ACİL DURDURMA AKTİF!');
            await emergencyStop();
        }
        
        // Kapı güvenlik kontrolü
        if (systemState.doorOpen && systemState.isRunning) {
            console.log('🚪 Kapı açık - güvenlik durdurmasi!');
            await pauseProgram();
        }
        
        // Program kontrolü
        if (systemState.isRunning && !systemState.isPaused) {
            await executeProgram();
        } else {
            // Durdurulmuş durumda tüm çıkışları kapat
            await setHeaterPowerAdvanced(0);
            await setVacuumControl(false);
        }
        
        // Son güncelleme zamanı
        systemState.lastUpdate = Date.now();
        
        // WebSocket güncellemesi
        broadcastSystemState();
        
    } catch (error) {
        console.error('❌ Ana kontrol döngüsü hatası:', error);
        systemState.errors.push('Kontrol döngüsü hatası');
    }
}

// Program yürütme
async function executeProgram() {
    const currentProgram = { ...programs[systemState.currentProgram], ...userPrograms[systemState.currentProgram] };
    
    if (!currentProgram || !currentProgram.steps) {
        console.error('❌ Geçersiz program');
        return;
    }
    
    const currentStep = currentProgram.steps[systemState.currentStep] || currentProgram.steps[0];
    
    // Hedef değerleri ayarla
    systemState.temperatures.target = currentStep.temp;
    
    // PID kontrol
    const pidOutput = pid.calculate(
        systemState.temperatures.target,
        systemState.temperatures.current
    );
    
    await setHeaterPowerAdvanced(pidOutput);
    
    // Vakum kontrolü
    if (currentStep.vacuum < 0) {
        await setVacuumControl(true, currentStep.vacuum);
    } else {
        await setVacuumControl(false);
    }
    
    // Süre kontrolü
    if (systemState.startTime) {
        systemState.elapsedTime = Math.floor((Date.now() - systemState.startTime) / 1000);
        
        // Adım süresi kontrolü
        const stepTotalTime = (currentStep.ramp || 0) + currentStep.time + (currentStep.hold || 0);
        
        if (systemState.elapsedTime >= stepTotalTime * 60) {
            // Sonraki adıma geç
            if (systemState.currentStep < currentProgram.steps.length - 1) {
                systemState.currentStep++;
                console.log(`➡️  Adım ${systemState.currentStep + 1}/${currentProgram.steps.length}'e geçiliyor`);
            } else {
                // Program tamamlandı
                console.log('✅ Program başarıyla tamamlandı!');
                await stopProgram();
            }
        }
    }
}

// Acil durdurma
async function emergencyStop() {
    systemState.isRunning = false;
    systemState.isPaused = false;
    systemState.temperatures.target = 0;
    
    await setHeaterPowerAdvanced(0);
    await setVacuumControl(false);
    await setFanControl(true); // Soğutma için fan aç
    
    pid.reset();
    
    console.log('🚨 ACİL DURDURMA YAPILDI!');
}

// Program duraklat
async function pauseProgram() {
    systemState.isPaused = true;
    await setHeaterPowerAdvanced(0);
    await setVacuumControl(false);
    
    console.log('⏸️  Program duraklatıldı');
}

// Program durdur
async function stopProgram() {
    systemState.isRunning = false;
    systemState.isPaused = false;
    systemState.startTime = null;
    systemState.elapsedTime = 0;
    systemState.currentStep = 0;
    systemState.temperatures.target = 0;
    
    await setHeaterPowerAdvanced(0);
    await setVacuumControl(false);
    await setFanControl(true); // Soğutma
    
    pid.reset();
    
    console.log('⏹️  Program durduruldu');
    
    // 5 dakika sonra fanı kapat
    setTimeout(async () => {
        if (!systemState.isRunning) {
            await setFanControl(false);
        }
    }, 5 * 60 * 1000);
}

// WebSocket broadcast
function broadcastSystemState() {
    if (wss) {
        const data = JSON.stringify({
            type: 'status',
            data: systemState,
            timestamp: Date.now()
        });
        
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                try {
                    client.send(data);
                } catch (error) {
                    console.error('WebSocket gönderme hatası:', error);
                }
            }
        });
    }
}

// =============================================================================
// REST API ENDPOINTS
// =============================================================================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (req, res) => {
    res.json({
        ...systemState,
        gpioAvailable: PIGPIO_AVAILABLE,
        currentTime: Date.now()
    });
});

app.get('/api/programs', (req, res) => {
    const allPrograms = { ...programs, ...userPrograms };
    const programList = Object.entries(allPrograms).map(([id, prog]) => ({
        id: parseInt(id),
        ...prog,
        isUserProgram: userPrograms.hasOwnProperty(id)
    }));
    res.json(programList);
});

app.post('/api/start', async (req, res) => {
    try {
        const { programId } = req.body;
        
        if (systemState.isRunning) {
            return res.status(400).json({ error: 'Program zaten çalışıyor' });
        }
        
        if (systemState.emergency) {
            return res.status(400).json({ error: 'Acil durdurma aktif' });
        }
        
        if (systemState.doorOpen) {
            return res.status(400).json({ error: 'Kapı açık' });
        }
        
        // Program seç
        if (programId && (programs[programId] || userPrograms[programId])) {
            systemState.currentProgram = programId;
        }
        
        const selectedProgram = programs[systemState.currentProgram] || userPrograms[systemState.currentProgram];
        
        if (!selectedProgram) {
            return res.status(400).json({ error: 'Geçersiz program' });
        }
        
        systemState.isRunning = true;
        systemState.isPaused = false;
        systemState.startTime = Date.now();
        systemState.elapsedTime = 0;
        systemState.currentStep = 0;
        systemState.totalSteps = selectedProgram.steps ? selectedProgram.steps.length : 1;
        systemState.errors = [];
        
        const firstStep = selectedProgram.steps ? selectedProgram.steps[0] : selectedProgram;
        systemState.temperatures.target = firstStep.temp;
        
        pid.reset();
        
        console.log(`🚀 Program başlatıldı: ${selectedProgram.name}`);
        console.log(`📊 Toplam ${systemState.totalSteps} adım`);
        
        res.json({ 
            status: 'started', 
            program: selectedProgram.name,
            steps: systemState.totalSteps,
            target: firstStep.temp
        });
        
    } catch (error) {
        console.error('❌ Program başlatma hatası:', error);
        res.status(500).json({ error: 'Program başlatılamadı' });
    }
});

app.post('/api/stop', async (req, res) => {
    try {
        await stopProgram();
        res.json({ status: 'stopped' });
    } catch (error) {
        console.error('❌ Program durdurma hatası:', error);
        res.status(500).json({ error: 'Program durdurulamadı' });
    }
});

app.post('/api/pause', async (req, res) => {
    try {
        if (!systemState.isRunning) {
            return res.status(400).json({ error: 'Program çalışmıyor' });
        }
        
        if (systemState.isPaused) {
            // Devam ettir
            systemState.isPaused = false;
            systemState.startTime = Date.now() - (systemState.elapsedTime * 1000);
            console.log('▶️  Program devam ediyor');
            res.json({ status: 'resumed', isPaused: false });
        } else {
            // Duraklat
            await pauseProgram();
            res.json({ status: 'paused', isPaused: true });
        }
        
    } catch (error) {
        console.error('❌ Program duraklat/devam hatası:', error);
        res.status(500).json({ error: 'İşlem gerçekleştirilemedi' });
    }
});

app.post('/api/emergency', async (req, res) => {
    try {
        await emergencyStop();
        res.json({ status: 'emergency_stopped' });
    } catch (error) {
        console.error('❌ Acil durdurma hatası:', error);
        res.status(500).json({ error: 'Acil durdurma gerçekleştirilemedi' });
    }
});

// Test endpoints
app.post('/api/test/ssr', async (req, res) => {
    try {
        console.log('🔧 SSR test başlıyor...');
        
        for (let i = 0; i < 3; i++) {
            await setHeaterPowerAdvanced(100);
            await sleep(1000);
            await setHeaterPowerAdvanced(0);
            await sleep(1000);
        }
        
        res.json({ 
            status: 'ok', 
            message: 'SSR 3 kez test edildi',
            gpioAvailable: PIGPIO_AVAILABLE
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/test/sensors', async (req, res) => {
    try {
        await readSensors();
        
        const tc1 = await readMAX6675Advanced(PINS.TC1_CS, PINS.TC1_DO, "TC1");
        const tc2 = await readMAX6675Advanced(PINS.TC2_CS, PINS.TC2_DO, "TC2");
        
        res.json({
            tc1: tc1 || 0,
            tc2: tc2 || 0,
            doorOpen: systemState.doorOpen,
            emergency: systemState.emergency,
            gpioAvailable: PIGPIO_AVAILABLE,
            status: 'ok'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/test/vacuum', async (req, res) => {
    try {
        await setVacuumControl(true, -50);
        await sleep(3000);
        await setVacuumControl(false);
        
        res.json({ 
            status: 'ok', 
            message: 'Vakum 3 saniye test edildi',
            gpioAvailable: PIGPIO_AVAILABLE
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/test/fan', async (req, res) => {
    try {
        await setFanControl(true);
        await sleep(3000);
        await setFanControl(false);
        
        res.json({ 
            status: 'ok', 
            message: 'Fan 3 saniye test edildi',
            gpioAvailable: PIGPIO_AVAILABLE
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// PID ayarları
app.post('/api/pid/tune', (req, res) => {
    try {
        const { kp, ki, kd } = req.body;
        
        if (typeof kp === 'number' && typeof ki === 'number' && typeof kd === 'number') {
            pid.setParameters(kp, ki, kd);
            res.json({ 
                status: 'ok', 
                message: 'PID parametreleri güncellendi',
                parameters: { kp, ki, kd }
            });
        } else {
            res.status(400).json({ error: 'Geçersiz PID parametreleri' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Kullanıcı programları
app.post('/api/programs/save', (req, res) => {
    try {
        const { name, steps } = req.body;
        
        if (!name || !steps || !Array.isArray(steps)) {
            return res.status(400).json({ error: 'Geçersiz program verisi' });
        }
        
        // Yeni ID bul
        const allPrograms = { ...programs, ...userPrograms };
        const maxId = Math.max(...Object.keys(allPrograms).map(Number), 0);
        const newId = maxId + 1;
        
        userPrograms[newId] = { name, steps };
        saveUserPrograms();
        
        res.json({ 
            status: 'ok', 
            message: 'Program kaydedildi',
            id: newId,
            program: userPrograms[newId]
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/programs/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        
        if (programs[id]) {
            return res.status(400).json({ error: 'Varsayılan programlar silinemez' });
        }
        
        if (userPrograms[id]) {
            delete userPrograms[id];
            saveUserPrograms();
            res.json({ status: 'ok', message: 'Program silindi' });
        } else {
            res.status(404).json({ error: 'Program bulunamadı' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Sistem bilgileri
app.get('/api/system/info', (req, res) => {
    res.json({
        gpio: PIGPIO_AVAILABLE,
        pigpio: PIGPIO_AVAILABLE && gpio && gpio.connected,
        pins: PINS,
        nodeVersion: process.version,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        platform: process.platform,
        arch: process.arch,
        pid: {
            kp: pid.kp,
            ki: pid.ki,
            kd: pid.kd,
            autoTune: pid.autoTune
        }
    });
});

// Hata temizleme
app.post('/api/errors/clear', (req, res) => {
    systemState.errors = [];
    res.json({ status: 'ok', message: 'Hatalar temizlendi' });
});

// =============================================================================
// WEBSOCKET SERVER
// =============================================================================

const wss = new WebSocket.Server({ 
    port: WS_PORT,
    perMessageDeflate: false,
    maxPayload: 1024 * 1024 // 1MB max
});

wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`📡 WebSocket istemci bağlandı: ${clientIP}`);
    
    // İlk durum bilgisini gönder
    ws.send(JSON.stringify({
        type: 'status',
        data: systemState,
        timestamp: Date.now()
    }));
    
    // Ping/pong için heartbeat
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            console.log('📡 WebSocket mesaj alındı:', data.type);
            
            // İstemci komutları buraya eklenebilir
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
            }
        } catch (error) {
            console.error('📡 WebSocket mesaj hatası:', error);
        }
    });
    
    ws.on('close', () => {
        console.log(`📡 WebSocket istemci ayrıldı: ${clientIP}`);
    });
    
    ws.on('error', (error) => {
        console.error('📡 WebSocket bağlantı hatası:', error);
    });
});

// WebSocket heartbeat
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
    });
}, 30000); // 30 saniye

wss.on('close', () => {
    clearInterval(heartbeat);
});

// =============================================================================
// UYGULAMA BAŞLATMA
// =============================================================================

async function startApplication() {
    console.log('🚀 BriLeX Dental Furnace Pro - Gelişmiş Ana Yazılım v2.0');
    console.log('================================================================');
    
    // Kullanıcı programlarını yükle
    loadUserPrograms();
    
    // GPIO'yu başlat
    const gpioOk = await setupGPIO();
    if (gpioOk) {
        console.log('✅ GPIO donanım kontrolü aktif');
    } else {
        console.log('⚠️  GPIO simülasyon modunda (pigpiod çalışmıyor olabilir)');
    }
    
    // Ana kontrol döngüsünü başlat
    console.log('🔄 Ana kontrol döngüsü başlatılıyor (500ms interval)...');
    setInterval(mainControlLoop, 500);
    
    // İlk sensör okumasını yap
    await mainControlLoop();
    
    // HTTP server'ı başlat
    app.listen(PORT, () => {
        console.log('📡 Sunucu bilgileri:');
        console.log(`   🌐 HTTP Server: http://localhost:${PORT}`);
        console.log(`   📡 WebSocket Server: ws://localhost:${WS_PORT}`);
        console.log('================================================================');
        console.log('🎯 BriLeX sistemi hazır ve çalışıyor!');
        console.log('');
        console.log('📋 Komutlar:');
        console.log('   • Web arayüzü: tarayıcıda http://localhost:3000');
        console.log('   • API test: curl http://localhost:3000/api/status');
        console.log('   • Durdurma: Ctrl+C');
    });
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 BriLeX sistemi kapatılıyor...');
    
    try {
        if (systemState.isRunning) {
            console.log('⏹️  Aktif program durdurluyor...');
            await stopProgram();
        }
        
        // Tüm çıkışları kapat
        await setHeaterPowerAdvanced(0);
        await setVacuumControl(false);
        await setFanControl(false);
        
        if (gpio && PIGPIO_AVAILABLE) {
            console.log('🔌 GPIO bağlantısı kapatılıyor...');
            await gpio.destroy();
        }
        
        // WebSocket server'ı kapat
        if (wss) {
            wss.close();
        }
        
        console.log('✅ Güvenli kapatma tamamlandı');
        console.log('👋 BriLeX sistemi kapatıldı');
        
    } catch (error) {
        console.error('❌ Kapatma sırasında hata:', error);
    } finally {
        process.exit(0);
    }
});

// Beklenmeyen hata yakalama
process.on('uncaughtException', (error) => {
    console.error('❌ Beklenmeyen hata:', error);
    // Acil durdurma yap
    if (systemState.isRunning) {
        emergencyStop().then(() => {
            process.exit(1);
        });
    } else {
        process.exit(1);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ İşlenmeyen Promise reddi:', reason);
});

// Uygulamayı başlat
startApplication().catch((error) => {
    console.error('❌ Uygulama başlatma hatası:', error);
    process.exit(1);
});
