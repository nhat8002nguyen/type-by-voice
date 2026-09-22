import SwiftUI

@main
struct TypeByVoiceApp: App {
    var body: some Scene {
        MenuBarExtra("Type by Voice", systemImage: "mic") {
            ContentView()
        }
    }
}

struct ContentView: View {
    var body: some View {
        Text("Type by Voice")
    }
}
