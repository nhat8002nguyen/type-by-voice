import SwiftUI

struct DictationOptionsControl: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Picker("Language", selection: Binding(
            get: { model.settings.dictationLanguage },
            set: { model.setDictationLanguage($0) }
        )) {
            ForEach(DictationLanguage.allCases, id: \.self) { language in
                Text(language.displayName).tag(language)
            }
        }

        Toggle("Translate to English", isOn: Binding(
            get: { model.settings.translateToEnglish },
            set: { model.setTranslateToEnglish($0) }
        ))
        .disabled(!model.settings.dictationOptions.canTranslate)
        .help(
            model.settings.dictationOptions.canTranslate
                ? "Dictate Vietnamese and insert the English translation."
                : "Translation only applies to Vietnamese or Auto-detect."
        )
    }
}
