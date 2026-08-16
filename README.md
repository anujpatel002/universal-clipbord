# 📋 MultiClip: Multi-PC Universal Clipboard & Large File Transfer

**MultiClip** is a lightweight, peer-to-peer desktop application that seamlessly synchronizes the OS clipboard (text & files) and transfers arbitrarily large files directly between multiple PCs on the same local network (LAN / Wi-Fi) with **zero cloud dependencies** and **minimal RAM usage**.

---

## ✨ Features

- **⚡ Seamless Cross-PC Copy & Paste**:
  - **Text**: Copy (<kbd>Ctrl</kbd> + <kbd>C</kbd>) on **PC-A** ➔ Paste (<kbd>Ctrl</kbd> + <kbd>V</kbd>) directly on **PC-B** in any application (Notepad, Word, Browser, Terminal, etc.).
  - **Files**: Copy a file in Windows File Explorer on **PC-A** ➔ MultiClip streams the file to **PC-B** and registers it with the Windows native clipboard ➔ Press <kbd>Ctrl</kbd> + <kbd>V</kbd> in Windows File Explorer on **PC-B** to paste the actual file directly into that directory.
- **🚀 Zero-RAM Streaming File Transfer**:
  - Streams files of any size (10 MB, 10 GB, 100 GB+) in fixed 1 MB binary chunks. Never loads entire files into memory.
  - Constant RAM footprint (~35-65 MB).
  - SHA-256 end-to-end file integrity verification.
  - Pause, Resume, and Cancel support with crash recovery.
- **🔍 Dual LAN Peer Discovery**:
  - **mDNS** (`bonjour-service`) + **UDP Subnet Broadcast Beacon** on port `49153`.
  - Automatic physical Wi-Fi/Ethernet adapter prioritization (filters out virtual Hyper-V / WSL switches).
  - **Direct IP Connect** (`+ Connect IP` button in UI) for networks with AP client isolation.
- **🔒 Cryptographic Pairing & Trust**:
  - Ed25519 public/private keypairs generated locally per device.
  - Interactive challenge-response handshake to accept/reject new peers.
  - Trust gating: untrusted devices cannot send clipboard updates or files.
- **💾 Local SQLite Database**:
  - Embedded `sql.js` (WebAssembly SQLite) engine with zero native build dependencies.
  - Persistent history for discovered devices, settings, transfers, and chunk bitmaps.

---

## 🛠️ Quick Start & Setup

### Prerequisites
- [Node.js](https://nodejs.org/) (version 20 or 22 recommended)
- [Git](https://git-scm.com/)

---

### 1. Setup on PC-1 (Main PC)

Open PowerShell or Terminal and run:

```powershell
# 1. Clone the repository
git clone https://github.com/anujpatel002/universal-clipbord.git
cd universal-clipbord

# 2. Install dependencies
npm install

# 3. Start the application
npm start
```

---

### 2. Setup on PC-2 (Second PC)

On your second PC on the same Wi-Fi / LAN network:

```powershell
# 1. Clone the repository
git clone https://github.com/anujpatel002/universal-clipbord.git
cd universal-clipbord

# 2. Install dependencies
npm install

# 3. Start the application
npm start
```

---

### 3. Pairing the Devices

1. Once both PCs have MultiClip open, each PC will automatically discover the other on the local network.
2. Click **`Pair Device`** next to the discovered PC.
3. An incoming pairing banner will appear on the other PC: click **`[Accept & Trust]`**.
4. Both PCs are now paired and securely authenticated!

> **Note on Windows Firewall / Network Isolation:**
> - When first running on Windows, click **"Allow access"** on the Windows Defender Firewall prompt for Private Networks.
> - If your Wi-Fi router blocks multicast (mDNS), simply click **`+ Connect IP`** in the app and type the IP address shown under *"This PC"* on the other device.

---

## 📦 Building Standalone `.exe` Files

To build a standalone Windows executable that can be run without Node.js installed:

### Build Portable `.exe` (Single file, no installation required)
```powershell
npm run dist:exe
```
The output file is located at:
```text
release/MultiClip 1.0.0.exe
```

### Build Windows Setup Installer
```powershell
npm run dist:installer
```
The output setup installer is located at:
```text
release/MultiClip Setup 1.0.0.exe
```

---

## 🧪 Testing

Run the automated test suite covering protocol framing, SQLite persistence, network handshakes, clipboard monitor, streaming transfer backpressure, and cryptographic pairing:

```powershell
npm test
```

Run TypeScript typecheck:
```powershell
npm run typecheck
```

---

## 🏗️ Architecture & Technology Stack

| Component | Technology | Purpose |
| :--- | :--- | :--- |
| **Desktop Shell** | Electron 34 | Cross-platform desktop runtime & native OS clipboard access |
| **Frontend UI** | React 19 + TypeScript + Vite | Dark-theme dashboard with real-time transfer progress |
| **Local Database** | `sql.js` (WebAssembly SQLite) | Embedded storage for device identities, transfers, and chunk bitmaps |
| **LAN Networking** | Node.js TCP Sockets (`node:net`) | High-throughput binary streaming & protocol message framing |
| **Peer Discovery** | `bonjour-service` + UDP Broadcast (`node:dgram`) | Dual mDNS and subnet beacon auto-discovery |
| **Security** | Node.js `node:crypto` | Ed25519 digital signatures & AES-256-GCM encryption |

---

## 📄 License
MIT License
