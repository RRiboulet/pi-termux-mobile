# Native UI-Abnahme für Spaces

Die Instrumentierung liegt außerhalb der normalen Source-Sets. Sie benötigt
keine zusätzlichen Android-/Test-Bibliotheken. Nur
`./gradlew --offline -PspaceUiAcceptance=true assembleDebug` aktiviert sie.
Ein normales `assembleDebug` oder Release-APK enthält weder Registrierung
noch Testklasse.

Auf dem ausdrücklich provisionierten Testgerät liest sie die private Datei
`files/home/.pi-mobile/ui-pairing-input.json` mit `prepare`, `qr` und `data`.
Sie bedient tatsächliche DOM-Formulare und sichtbare Buttons, wartet auf die
UI-Antwort und gibt nur Status, öffentliche Key-ID und Objektanzahl aus.
Modi: `prepare`, `pair`, `data`, `authenticate`, `enrollStatus`, `objects`,
`rotationStatus`.

Start: `adb shell am instrument -w -e mode MODE
app.pidabl/org.pimobile.app.test.SpaceUiInstrumentation`; während des
Starts die Activity mit `adb shell am start -n app.pidabl/.MainActivity`
in den Vordergrund holen. Die Erstkopplung benötigt eine bewusst ersetzte
eigene Identität und einen aktuellen, kurzlebigen Enrollment-QR-Inhalt.
Nach der Abnahme die verbrauchte private Eingabedatei entfernen, normale
APK bauen/installieren und den Objektzugriff erneut prüfen.

Der echte Lauf am 2026-10-11 hat Prepare, QR-Payload-Pairing, Datenformular,
Authentifizierung und Objektanzeige bestanden; der alte Schlüssel ist widerrufen.
