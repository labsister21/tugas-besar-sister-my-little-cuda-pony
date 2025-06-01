cara jalanin

1. jalanin skrip `runDocker.sh`

   ```
   chmod +x runDocker.sh
   ./runDocker.sh <jumlah_server> <jumlah_klien>
   ```

2. ntar terminal bakal lgsg ngejalanin client 1, kalo mau pindah client pake command ini dimana `i` itu menyatakan client ke-`i`

   ```
   docker exec -it raft-client-{i} bash -c "npm run dev client"
   ```
