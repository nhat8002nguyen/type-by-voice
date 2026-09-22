struct AudioRingBuffer: Sendable {
    private var storage: [Float]
    private var head: Int
    private var count: Int

    init(capacitySamples: Int) {
        storage = Array(repeating: 0, count: capacitySamples)
        head = 0
        count = 0
    }

    var available: Int { count }

    mutating func write(_ samples: [Float]) {
        let incoming = samples.count > storage.count
            ? Array(samples.suffix(storage.count))
            : samples
        for sample in incoming {
            if count == storage.count {
                head = (head + 1) % storage.count
                count -= 1
            }
            let index = (head + count) % storage.count
            storage[index] = sample
            count += 1
        }
    }

    mutating func read(count requested: Int) -> [Float] {
        let n = min(requested, available)
        var result = [Float]()
        result.reserveCapacity(n)
        for _ in 0..<n {
            result.append(storage[head])
            head = (head + 1) % storage.count
            count -= 1
        }
        return result
    }

    mutating func clear() {
        head = 0
        count = 0
    }
}
