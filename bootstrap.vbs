' =============================================================================
' bootstrap.vbs                                                        v1.0.0
' -----------------------------------------------------------------------------
' Aguarda ate 30 min (120 x 15s) pelo launcher.vbs e o executa.
'
' POR QUE ESTE ARQUIVO EXISTE COMO ARQUIVO (e nao e' mais gerado):
' Ate a v1.10.2, instalar-na-inicializacao.bat GERAVA este script linha a linha
' com "echo" dentro de um bloco redirecionado. Isso exige escapar ( ) & < > com
' ^ e conviver com as regras de expansao do cmd -- e falhou de tres formas
' diferentes em producao:
'   1. um ")" sem escape fechava o bloco antes da hora e o arquivo saia pela
'      metade (o resto virava comando executado na tela);
'   2. gravado com [Text.Encoding]::UTF8, ganhava BOM e o wscript recusava
'      com "Caractere invalido, Linha 1, Caract. 1" (800A0408);
'   3. escapes vazando produziam "Erro de sintaxe" na linha 6 (800A03EA).
' Copiar um arquivo pronto nao tem escape, nao tem expansao e nao tem encoding
' a definir -- e' a operacao mais simples que resolve o problema, e elimina a
' classe inteira de falhas de uma vez.
'
' O caminho do launcher NAO fica embutido aqui (era ele que exigia geracao
' dinamica). Vem de "launcher.path", um arquivo texto de UMA linha gravado ao
' lado deste, que o instalador escreve com um unico "echo" sem escape nenhum.
'
' CHANGELOG 1.0.0 - 2026-08-12 22:30 - Criado como arquivo estatico do projeto,
'   substituindo a geracao dinamica por echo em instalar-na-inicializacao.bat.
' =============================================================================

Option Explicit

Dim fso, sh, pastaAtual, arqPath, vbsPath, maxT, n

On Error Resume Next
Set fso = CreateObject("Scripting.FileSystemObject")
If Err.Number <> 0 Then WScript.Quit 1
Set sh = CreateObject("WScript.Shell")
If Err.Number <> 0 Then WScript.Quit 1
On Error Goto 0

' Le o caminho do launcher a partir de launcher.path (mesma pasta deste script).
pastaAtual = fso.GetParentFolderName(WScript.ScriptFullName)
arqPath = fso.BuildPath(pastaAtual, "launcher.path")

If Not fso.FileExists(arqPath) Then WScript.Quit 2

On Error Resume Next
vbsPath = Trim(fso.OpenTextFile(arqPath, 1).ReadLine)
If Err.Number <> 0 Then WScript.Quit 3
On Error Goto 0

If Len(vbsPath) = 0 Then WScript.Quit 4

' Aguarda o launcher aparecer. A pasta pode ser de rede e ainda nao estar
' montada no momento do logon, por isso a espera longa.
maxT = 120
n = 0
Do While n < maxT
    If fso.FileExists(vbsPath) Then
        sh.Run "wscript.exe " & Chr(34) & vbsPath & Chr(34), 0, False
        WScript.Quit 0
    End If
    n = n + 1
    WScript.Sleep 15000
Loop

' Esgotou o tempo sem encontrar o launcher.
WScript.Quit 5
