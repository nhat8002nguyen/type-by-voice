import Foundation

final class MockDictateProcess {
    let url: URL
    private let process: Process

    private init(url: URL, process: Process) {
        self.url = url
        self.process = process
    }

    static func start() throws -> MockDictateProcess {
        let thisFile = URL(fileURLWithPath: #filePath)
        let contractsDir = thisFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("contracts/dictation-v1")

        let nodeURL = try resolveNodeExecutable()
        var environment = ProcessInfo.processInfo.environment
        let nodeDir = nodeURL.deletingLastPathComponent().path
        let path = environment["PATH"] ?? ""
        if !path.split(separator: ":").contains(where: { String($0) == nodeDir }) {
            environment["PATH"] = "\(nodeDir):\(path)"
        }

        let process = Process()
        process.executableURL = nodeURL
        process.arguments = [
            "--import", "./ts-resolve.ts",
            "--experimental-strip-types",
            "src/cli-mock.ts",
        ]
        process.currentDirectoryURL = contractsDir
        process.environment = environment

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr
        try process.run()

        let deadline = Date().addingTimeInterval(10)
        var buffer = Data()
        while Date() < deadline {
            let chunk = stdout.fileHandleForReading.availableData
            if !chunk.isEmpty {
                buffer.append(chunk)
            }
            if let line = String(data: buffer, encoding: .utf8),
               let match = line.split(separator: "\n").first(where: { $0.hasPrefix("MOCK_URL=") })
            {
                let urlString = String(match.dropFirst("MOCK_URL=".count))
                guard let url = URL(string: urlString) else {
                    process.terminate()
                    throw NSError(
                        domain: "MockDictateProcess",
                        code: 2,
                        userInfo: [NSLocalizedDescriptionKey: "invalid MOCK_URL \(urlString)"]
                    )
                }
                return MockDictateProcess(url: url, process: process)
            }
            if !process.isRunning {
                let err = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
                let out = String(data: buffer, encoding: .utf8) ?? ""
                throw NSError(
                    domain: "MockDictateProcess",
                    code: 3,
                    userInfo: [
                        NSLocalizedDescriptionKey:
                            "mock process exited before MOCK_URL (node=\(nodeURL.path)) stderr=\(err) stdout=\(out)",
                    ]
                )
            }
            Thread.sleep(forTimeInterval: 0.05)
        }

        process.terminate()
        throw NSError(
            domain: "MockDictateProcess",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "timed out waiting for MOCK_URL"]
        )
    }

    func stop() {
        guard process.isRunning else { return }
        process.terminate()
        process.waitUntilExit()
    }

    private static func resolveNodeExecutable() throws -> URL {
        var candidates: [String] = [
            "/usr/local/opt/node/bin/node",
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
        ]
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            for dir in path.split(separator: ":") {
                candidates.append(URL(fileURLWithPath: String(dir)).appendingPathComponent("node").path)
            }
        }
        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        throw NSError(
            domain: "MockDictateProcess",
            code: 4,
            userInfo: [NSLocalizedDescriptionKey: "node executable not found"]
        )
    }
}
