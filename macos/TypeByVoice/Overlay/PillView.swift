import SwiftUI

struct PillView: View {
    var model: OverlayModel
    var onRetry: () -> Void = {}

    var body: some View {
        HStack(spacing: 10) {
            if model.showsLevel {
                LevelMeter(level: model.level)
                Text(model.elapsedText)
                    .monospacedDigit()
            } else if model.showsIndeterminateProgress {
                ProgressView()
                    .controlSize(.small)
                if !model.caption.isEmpty {
                    Text(model.caption)
                }
            } else if !model.caption.isEmpty {
                Text(model.caption)
            }

            if model.showsRetry {
                Button("Retry", action: onRetry)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }

            if model.showsUpgrade {
                Button("Upgrade") {}
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(true)
            }
        }
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(.primary)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: Capsule())
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct LevelMeter: View {
    var level: Double

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(0..<5, id: \.self) { index in
                Capsule()
                    .fill(barColor(for: index))
                    .frame(width: 3, height: barHeight(for: index))
            }
        }
        .frame(width: 24, height: 18)
        .accessibilityLabel("Input level")
    }

    private func barHeight(for index: Int) -> CGFloat {
        let thresholds: [CGFloat] = [6, 10, 14, 10, 6]
        let active = level > Double(index) / 5.0
        return active ? thresholds[index] : 4
    }

    private func barColor(for index: Int) -> Color {
        level > Double(index) / 5.0 ? Color.accentColor : Color.secondary.opacity(0.35)
    }
}
