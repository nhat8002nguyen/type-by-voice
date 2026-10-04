import XCTest
@testable import TypeByVoice

final class DictationOptionsTests: XCTestCase {
    func testApiValueMapsLanguages() {
        XCTAssertEqual(DictationLanguage.english.apiValue, "en")
        XCTAssertEqual(DictationLanguage.vietnamese.apiValue, "vi")
        XCTAssertNil(DictationLanguage.auto.apiValue)
    }

    func testCanTranslateIsFalseForEnglish() {
        XCTAssertFalse(DictationOptions(language: .english, translateToEnglish: true).canTranslate)
        XCTAssertTrue(DictationOptions(language: .vietnamese, translateToEnglish: false).canTranslate)
        XCTAssertTrue(DictationOptions(language: .auto, translateToEnglish: true).canTranslate)
    }

    func testStartPayloadCarriesVietnameseAndTranslate() throws {
        let payload = StartPayload(
            requestId: "r",
            language: DictationLanguage.vietnamese.apiValue,
            translateToEnglish: true,
            platform: "macos",
            clientVersion: "1.0.0+12",
            deviceId: "d",
            listInHistory: true
        )
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any]
        XCTAssertEqual(json?["language"] as? String, "vi")
        XCTAssertEqual(json?["translateToEnglish"] as? Bool, true)
    }

    func testStartPayloadOmitsLanguageForAuto() throws {
        let payload = StartPayload(
            requestId: "r",
            language: DictationLanguage.auto.apiValue,
            translateToEnglish: false,
            platform: "macos",
            clientVersion: "1.0.0+12",
            deviceId: "d",
            listInHistory: true
        )
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any]
        XCTAssertNil(json?["language"])
        XCTAssertEqual(json?["translateToEnglish"] as? Bool, false)
    }
}
