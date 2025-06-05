# Rafted: Distributed Key-Value Store with Raft Consensus

Tugas Besar 1  
IF3130 - Sistem Paralel dan Terdistribusi  
**“Rafted”**  
Consensus Protocol: Raft

---

## Deskripsi

**Rafted** adalah implementasi protokol konsensus Raft dalam bahasa TypeScript (Node.js) untuk membangun distributed key-value in-memory storage. Sistem ini mendukung heartbeat, leader election, log replication, dan membership change, serta menyediakan layanan key-value sederhana (`ping`, `get`, `set`, `strln`, `del`, `append`) yang dapat diakses melalui client CLI.

---

## Fitur

- **Heartbeat:** Monitoring dan pesan periodik antar node.
- **Leader Election:** Otomatis failover jika leader gagal.
- **Log Replication:** Semua aksi client dicatat dan direplikasi ke seluruh cluster.
- **Membership Change:** Tambah/hapus node secara dinamis saat cluster berjalan.
- **Distributed KV Store:** Mendukung perintah `ping`, `get`, `set`, `strln`, `del`, `append`.
- **Request Log:** Client dapat meminta log dari leader.
- **CLI Client:** Interaktif, mendukung koneksi ke node manapun dan otomatis redirect ke leader.
- **Persistent Storage:** Log dan snapshot disimpan di disk.
- **Unit Test:** Tersedia di folder `tests/`.

---

## Struktur Folder

```
.
├── src/
│   ├── client.ts           # CLI client
│   ├── clusterConfig.ts    # Konfigurasi cluster
│   ├── index.ts            # Entry point
│   ├── persistentStorage.ts# Persistent log & snapshot
│   ├── raftNode.ts         # Implementasi Raft node
│   ├── server.ts           # HTTP server (REST API)
│   └── types.ts            # Tipe data & interface
├── tests/
│   └── raft.test.ts        # Unit tests
├── raft-data/              # Data persistent tiap node
├── Dockerfile
├── docker-compose.yml
├── runDocker.sh            # Skrip setup cluster & client (Docker)
├── runCommands.sh          # Skrip demo otomatis
├── package.json
├── tsconfig.json
└── readme.md
```

---

## Cara Menjalankan

### 1. Jalankan Cluster & Client (Docker)

```sh
chmod +x runDocker.sh
./runDocker.sh <jumlah_server> <jumlah_client>
```

- Contoh: `./runDocker.sh 4 2` akan menjalankan 4 server dan 2 client.

### 2. Masuk ke Client

```sh
docker exec -it raft-client-1 bash -c "npm run dev client"
```

Ganti angka `1` sesuai client yang ingin digunakan.

### 3. Perintah CLI Client

- `connect <nodeId>` — Koneksi ke node tertentu
- `disconnect <nodeId>` — Putus koneksi dari node
- `[<nodeId>] ping` — Cek koneksi (PONG)
- `[<nodeId>] get <key>` — Ambil nilai
- `[<nodeId>] set <key> <value>` — Set nilai
- `[<nodeId>] strln <key>` — Panjang string value
- `[<nodeId>] del <key>` — Hapus key
- `[<nodeId>] append <key> <value>` — Tambah string ke value
- `request_log` — Lihat log dari leader
- `add_node <nodeId>` — Tambah node ke cluster
- `remove_node <nodeId>` — Hapus node dari cluster
- `exit` — Keluar dari client

> `[<nodeId>]` opsional, untuk memilih node target.

---

## API Endpoint (Server)

- `POST /raft/vote` — Vote request (internal Raft)
- `POST /raft/append` — Append entries (internal Raft)
- `POST /execute` — Eksekusi perintah client (hanya leader)
- `GET /request_log` — Ambil log dari leader
- `GET /health` — Status node & info leader
- `POST /cluster/add` — Tambah node ke cluster
- `DELETE /cluster/remove/:nodeId` — Hapus node dari cluster
- `GET /snapshot` — Ambil snapshot data

---

## Testing

Jalankan unit test dengan:

```sh
npm run test
```

---

## Penjelasan Arsitektur

- **RaftNode** ([src/raftNode.ts](src/raftNode.ts)): Inti protokol Raft (heartbeat, election, log replication, membership change).
- **RaftServer** ([src/server.ts](src/server.ts)): REST API untuk komunikasi antar node & client.
- **RaftClient** ([src/client.ts](src/client.ts)): CLI interaktif untuk user.
- **PersistentStorage** ([src/persistentStorage.ts](src/persistentStorage.ts)): Simpan log dan snapshot ke disk.
- **Konfigurasi cluster** ([src/clusterConfig.ts](src/clusterConfig.ts)): Daftar node dalam cluster.

---

## Dependencies

Lihat [package.json](package.json) untuk daftar lengkap.

- express
- axios
- uuid
- typescript
- jest (dev)  
- supertest (dev)
- ts-node (dev)

---

## Referensi

- [Raft Paper](https://raft.github.io/raft.pdf)
- [Raft Visualization](http://thesecretlivesofdata.com/raft/)
- [Membership Change](https://github.com/hashicorp/raft/blob/main/membership.md)

---

## Anggota

| NIM         | Nama Lengkap         |
|-------------|---------------------|
| 13522135    | Christian Justin Hendrawan      |
| 13522147    | Ikhwan Al Hakim      |
| 13522149    | Muhammad Dzaki Arta      |
