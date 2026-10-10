const crypto = require('crypto');

/**
 * WMS Client for Node.js
 * Handles device registration, checkin, and WebRTC credential retrieval
 */

class WMSClient {
  constructor(wmsUrl, groupToken) {
    this.wmsUrl = this.normalizeWmsUrl(wmsUrl);
    this.groupToken = groupToken;
    this.deviceId = null;
    this.authCode = null;
    this.encryptionKey = null;
  }

  normalizeWmsUrl(url) {
    url = url.trim().replace(/\/$/, '');
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = 'https://' + url;
    }
    if (!url.endsWith('/ccm-web')) {
      url = url + '/ccm-web';
    }
    return url;
  }

  generateRandomMac() {
    return Array.from({ length: 6 }, () =>
      Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
    ).join('');
  }

  generateRandomIp() {
    return `10.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}.${Math.floor(Math.random() * 254) + 1}`;
  }

  generateRandomSerial(length = 11) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  }

  async registerDevice() {
    const mac = this.generateRandomMac();
    const ip = this.generateRandomIp();
    const serial = this.generateRandomSerial();

    const devicePayload = {
      wmsConfig: 'WMS20',
      agentCryptoVersion: 3,
      hashVersion: 2,
      isBlobSupported: true,
      currentlyLoggedInUser: 'turndiag\\user',
      brokerServer: {
        type: 'None',
        url: 'none',
        logonusers: [{ username: 'turndiag\\user', logintime: new Date().toISOString() }]
      },
      isDiskLoggingEnabled: false,
      owner: { id: 0 },
      ccmAgentVersion: '5.0.0.5',
      deviceType: { type: 6, family: 6 },
      deviceOsType: { type: 9, description: 'WTOS' },
      osBuildVersion: '2402 (9.5.1079)',
      modelName: 'Latitude 5440',
      deviceTypeDesc: 'Thin OS (Latitude 5440)',
      modelId: 'Latitude5440',
      devicePlatformType: {
        oem: 0,
        hardware: 2,
        type: 0,
        description: 'Latitude 5440',
        modelCode: '0C00'
      },
      name: 'TurnDiag-Device',
      cpuFamily: '13th Gen Intel(R) Core(TM) i5-1345U @ 2.49 GHz',
      storages: [{ totalSpace: 226174, availableSpace: 220096, mountedPath: '/' }],
      serialNum: serial,
      tags: 'N/A',
      uptime: '1D 0:0:0',
      locale: 'English',
      timezoneName: 'UTC',
      keyboardLayout: 'US',
      hardwareSummary: {
        cpu: '2.49 GHz',
        cpuSpeed: '2.49 GHz',
        memory: '16360068',
        bios: '1.5.0'
      },
      macAddress: mac,
      ip: ip,
      networkInterfaces: [{
        name: 'ENET0',
        ip: ip,
        subnetmask: '255.255.255.0',
        gateway: '10.0.0.1',
        dns1: '10.0.0.5',
        dns2: 'N/A',
        mac: mac,
        isDhcp: 'true',
        isCurrent: 1
      }],
      deviceCurrentSetting: {
        timeServers: 'pool.ntp.org',
        privilageLevel: 'High',
        dualHeadMode: 'mirror'
      },
      largeLogUpload: true
    };

    // Step 1: Pre-register to get PersonID
    const groupPayload = {
      _id: null,
      createdAt: null,
      id: 0,
      updatedAt: null,
      isActive: true,
      groupToken: this.groupToken
    };

    const registerResponse = await fetch(`${this.wmsUrl}/open/deviceGroupLogin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify(groupPayload)
    });

    if (!registerResponse.ok) {
      throw new Error(`Pre-register failed: ${registerResponse.status}`);
    }

    const registerData = await registerResponse.json();
    const personId = registerData.id;

    // Step 2: Register device
    const deviceResponse = await fetch(`${this.wmsUrl}/open/deviceRegister`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'X-Stratus-device-owner-id': personId.toString()
      },
      body: JSON.stringify(devicePayload)
    });

    if (!deviceResponse.ok) {
      throw new Error(`Device register failed: ${deviceResponse.status}`);
    }

    const deviceData = await deviceResponse.json();
    this.deviceId = deviceData.wyseIdentifier;
    this.authCode = deviceData.authenticationCode;

    return { personId, serial, mac, ip };
  }

  generateAuthToken() {
    const currentMilli = Date.now();
    const tokenRaw = this.deviceId + currentMilli + this.authCode;
    const md5 = crypto.createHash('md5').update(tokenRaw).digest();
    return Buffer.from(md5).toString('base64').trim();
  }

  async deviceCheckin() {
    const authToken = this.generateAuthToken();
    const utcNow = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');

    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      'X-Stratus-date': utcNow,
      'User-Agent': 'Stratus /5.0.0.5  (DellThinOS 9.5.3007; utf-8;  Latitude 5440;  Revision:12.3.432.1:  ; cls: D )',
      'X-Stratus-device-authentication-code': authToken,
      'X-Stratus-device-id': this.deviceId
    };

    const checkinResponse = await fetch(`${this.wmsUrl}/device/checkin`, {
      method: 'POST',
      headers
    });

    return checkinResponse.ok;
  }

  async getEncryptionKey() {
    const authToken = this.generateAuthToken();
    const utcNow = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');

    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      'X-Stratus-date': utcNow,
      'User-Agent': 'Stratus /5.0.0.5  (DellThinOS 9.5.3007; utf-8;  Latitude 5440;  Revision:12.3.432.1:  ; cls: D )',
      'X-Stratus-device-authentication-code': authToken,
      'X-Stratus-device-id': this.deviceId
    };

    const keyResponse = await fetch(`${this.wmsUrl}/device/getKey?wyseId=${this.deviceId}`, {
      method: 'GET',
      headers
    });

    if (!keyResponse.ok) {
      throw new Error(`Get encryption key failed: ${keyResponse.status}`);
    }

    this.encryptionKey = await keyResponse.text();
    return this.encryptionKey;
  }

  decryptAesCtr(encryptedB64, ivLength = 16) {
    const key = Buffer.from(this.encryptionKey, 'base64');
    const raw = Buffer.from(encryptedB64, 'base64');
    const iv = raw.slice(0, ivLength);
    const ciphertext = raw.slice(ivLength);

    const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf8');
  }

  decryptWebRTCFields(encryptedJson) {
    const decrypted = {};
    for (const [key, encryptedValue] of Object.entries(encryptedJson)) {
      try {
        const plain = this.decryptAesCtr(encryptedValue);
        // Strip the leading base64-salt that ends with '=='
        const parts = plain.split('==', 2);
        decrypted[key] = parts.length === 2 ? parts[1] : plain;
      } catch (e) {
        decrypted[key] = `<decryption failed: ${e.message}>`;
      }
    }
    return decrypted;
  }

  async getWebRTCDetails() {
    const authToken = this.generateAuthToken();
    const utcNow = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z/, ' UTC');

    const headers = {
      'Content-Type': 'application/json;charset=UTF-8',
      'X-Stratus-date': utcNow,
      'User-Agent': 'Stratus /5.0.0.5  (DellThinOS 9.5.3007; utf-8;  Latitude 5440;  Revision:12.3.432.1:  ; cls: D )',
      'X-Stratus-device-authentication-code': authToken,
      'X-Stratus-device-id': this.deviceId
    };

    const webrtcResponse = await fetch(`${this.wmsUrl}/device/getWebRTCDetails`, {
      method: 'GET',
      headers
    });

    if (!webrtcResponse.ok) {
      throw new Error(`Get WebRTC details failed: ${webrtcResponse.status}`);
    }

    const encryptedJson = await webrtcResponse.json();
    return this.decryptWebRTCFields(encryptedJson);
  }

  async getTurnCredentials() {
    await this.registerDevice();
    await this.deviceCheckin();
    await this.getEncryptionKey();
    const webrtcDetails = await this.getWebRTCDetails();

    return {
      turnServerURL: webrtcDetails.turnServerURL,
      stunServerURL: webrtcDetails.stunServerURL,
      userID: webrtcDetails.userID,
      phrase: webrtcDetails.phrase
    };
  }
}

module.exports = WMSClient;
