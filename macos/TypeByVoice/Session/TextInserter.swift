import Foundation

@MainActor
protocol TextInserter: AnyObject {
    func insert(_ text: String) async
}
