defmodule Ledger.MixProject do
  use Mix.Project

  def project do
    [app: :ledger, version: "0.1.0", elixir: "~> 1.17", deps: deps()]
  end

  defp deps do
    [{:plug_cowboy, "~> 2.7"}, {:ecto_sql, "~> 3.12"}]
  end
end
